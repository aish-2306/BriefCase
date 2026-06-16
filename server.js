const express = require('express');
const { GoogleGenAI } = require('@google/genai');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const audioCacheDir = path.join(__dirname, 'public', 'audio');
if (!fs.existsSync(audioCacheDir)){
    fs.mkdirSync(audioCacheDir, { recursive: true });
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:5000/auth/google/callback'
);

// --- NATIVE AUTHENTICATION ENDPOINTS ---
app.post('/api/auth/signup', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { password, name } = req.body;
    
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    
    // Explicitly write to public users tracking table
    const { error: upsertError } = await supabase
        .from('users')
        .upsert({ email: email, name: name, voice_accent: 'en-US-AriaNeural' }, { onConflict: 'email' });
        
    if (upsertError) console.error("Signup SQL Table insertion failure:", upsertError);
    return res.json({ email: email });
});

app.post('/api/auth/signin', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { password } = req.body;
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ email: data.user.email.toLowerCase() });
});

app.get('/api/user-details', async (req, res) => {
    const email = req.query.email.toLowerCase().trim();
    const { data, error } = await supabase.from('users').select('name').eq('email', email).single();
    if (error || !data) return res.json({ name: null });
    return res.json({ name: data.name });
});

app.get('/api/check-google-link', async (req, res) => {
    const email = req.query.email.toLowerCase().trim();
    const { data, error } = await supabase.from('users').select('google_refresh_token').eq('email', email).single();
    if (error || !data || !data.google_refresh_token) {
        return res.json({ hasToken: false });
    }
    return res.json({ hasToken: true });
});

// --- GOOGLE OAUTH INTERSECT LINKAGE ---
app.get('/auth/google', (req, res) => {
    const userEmailState = req.query.email.toLowerCase().trim();
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Forces fresh authorization and generation of refresh tokens
        state: userEmailState,
        scope: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly']
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query;
    const targetEmail = state.toLowerCase().trim();
    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        if (!tokens.refresh_token) {
            console.log("⚠️ Google didn't return a refresh token. Attempting fallback collection...");
        }

        // BULLETPROOF FIX: Use upsert instead of update here. 
        // If your database profile row is missing, this automatically seeds it dynamically!
        const { error } = await supabase.from('users').upsert({
            email: targetEmail,
            google_refresh_token: tokens.refresh_token
        }, { onConflict: 'email' });

        if (error) throw error;

        res.redirect(`/?login_success=true&email=${encodeURIComponent(targetEmail)}&google_linked=true`);
    } catch (err) {
        console.error("Auth Linkage failure:", err);
        res.status(500).send("Verification alignment break.");
    }
});

// --- CORE PIPELINE AUDIO AUTOMATION GENERATOR ---
app.post('/api/generate-brief', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { localWeather, localClock } = req.body;

    try {
        const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
        if (error || !user || !user.google_refresh_token) {
            return res.status(404).json({ error: "Google data synchronization missing." });
        }

        const userAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        userAuth.setCredentials({ refresh_token: user.google_refresh_token });

        const calendar = google.calendar({ version: 'v3', auth: userAuth });
        const gmail = google.gmail({ version: 'v1', auth: userAuth });

        const [calendarData, gmailData] = await Promise.all([
            calendar.events.list({
                calendarId: 'primary',
                timeMin: new Date().toISOString(),
                maxResults: 5,
                singleEvents: true,
                orderBy: 'startTime'
            }),
            gmail.users.messages.list({ userId: 'me', q: 'is:starred', maxResults: 3 })
        ]);

        let customPriorityEmails = [];
        if (gmailData.data.messages) {
            for (let msg of gmailData.data.messages) {
                const content = await gmail.users.messages.get({ userId: 'me', id: msg.id });
                customPriorityEmails.push(content.data.snippet);
            }
        }

        const consolidatedData = {
            currentTime: localClock,
            currentWeather: localWeather,
            calendar: calendarData.data.items.map(item => `${item.summary} starting at ${item.start.dateTime || item.start.date}`),
            starredInboxSnippets: customPriorityEmails,
            whatsappAlerts: user.whatsapp_snippet
        };

        let aiResponse;
        try {
            aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `You are an elite executive chief of staff. Review this raw environment metric: ${JSON.stringify(consolidatedData)}.
                Compose a human, beautifully structured narrative spoken script. 
                STRICT PROTOCOLS:
                1. You MUST start the script word-for-word with: "Good Morning, Boss."
                2. Do not use structural markdown elements (like asterisks, headers, lists, or bullets).
                3. Do not include programmatic labels or sound cues. Deliver text meant strictly for fluid reading.
                4. Blend schedules, priority alerts, and external metrics naturally.`
            });
        } catch (modelErr) {
            console.log("Primary endpoint unavailable, utilizing adaptive rendering fallback layer...");
            aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Write a casual daily summary text transcript based on this objective block: ${JSON.stringify(consolidatedData)}. Start strictly with: "Good Morning, Boss." Clear all markdown syntax elements.`
            });
        }

        const scriptText = aiResponse.text;
        
        const tts = new MsEdgeTTS();
        const activeVoice = user.voice_accent || 'en-US-AriaNeural';
        await tts.setMetadata(activeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        
        const uniqueSubDirName = `brief-${Date.now()}`;
        const finalTargetDir = path.join(audioCacheDir, uniqueSubDirName);
        
        if (!fs.existsSync(finalTargetDir)){
            fs.mkdirSync(finalTargetDir, { recursive: true });
        }

        await tts.toFile(finalTargetDir, scriptText);

        return res.json({ text: scriptText, streamUrl: `/audio/${uniqueSubDirName}/audio.mp3` });

    } catch (pipelineErr) {
        console.error("Pipeline breakdown:", pipelineErr);
        return res.status(500).json({ error: pipelineErr.message });
    }
});

app.post('/api/update-voice', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { voiceAccent } = req.body;
    const { error } = await supabase.from('users').update({ voice_accent: voiceAccent }).eq('email', email);
    if (error) return res.status(500).json({ error: "Database update failure." });
    return res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("🚀 AuraBrief Core Engine Active on Port " + PORT);
    const url = `http://localhost:${PORT}`;
    const startCmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(startCmd);
});