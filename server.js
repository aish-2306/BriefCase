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

// Pure SPA URL: Pointing strictly to your base landing domain
const productionURL = process.env.NODE_ENV === 'production' 
    ? 'https://briefcase-nqsy.onrender.com' 
    : 'http://localhost:5000';

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    productionURL
);

// Helper function to process TTS with an inline retry mechanism
async function compileSpeechWithRetry(ttsEngine, targetDirectory, textContent, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const cleanText = textContent.replace(/[*#_`\-]/g, ' ').trim();
            await ttsEngine.toFile(targetDirectory, cleanText);
            return;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`🔄 TTS server stutter detected. Retrying voice compilation (Attempt ${i + 1}/${retries})...`);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// Helper function to handle exponential backoff for 503 resilience
async function generateContentWithRetry(prompt, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt
            });
        } catch (err) {
            if (err.status === 503 || JSON.stringify(err).includes('503') || i === retries - 1) {
                console.log(`⚠️ Gemini 503 traffic bottleneck detected. Retrying in ${delay}ms... (Attempt ${i + 1}/${retries})`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                continue;
            }
            throw err;
        }
    }
}

// --- NATIVE AUTHENTICATION ENDPOINTS ---
app.post('/api/auth/signup', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { password, name } = req.body;
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    await supabase.from('users').upsert({ email: email, name: name, voice_accent: 'en-US-AriaNeural' }, { onConflict: 'email' });
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
    if (error || !data || !data.google_refresh_token) return res.json({ hasToken: false });
    return res.json({ hasToken: true });
});

// --- DYNAMIC AUTO-STAR RULES MANAGEMENT ENDPOINTS ---
app.get('/api/rules', async (req, res) => {
    const email = req.query.email.toLowerCase().trim();
    const { data, error } = await supabase.from('auto_star_rules').select('*').eq('user_email', email);
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

app.post('/api/rules/add', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { targetSender, customLabel } = req.body;
    const { error } = await supabase.from('auto_star_rules').upsert({
        user_email: email,
        target_sender: targetSender.toLowerCase().trim(),
        custom_label: customLabel || 'from school'
    }, { onConflict: 'user_email,target_sender' });
    
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
});

app.post('/api/rules/delete', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { ruleId } = req.body;
    const { error } = await supabase.from('auto_star_rules').delete().eq('id', ruleId).eq('user_email', email);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
});

// --- GOOGLE OAUTH INTERSECT LINKAGE ---
app.get('/auth/google', (req, res) => {
    const userEmailState = req.query.email.toLowerCase().trim();
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        state: userEmailState,
        scope: [
            'https://www.googleapis.com/auth/calendar.readonly', 
            'https://www.googleapis.com/auth/gmail.modify', 
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/gmail.labels'
        ]
    });
    res.redirect(url);
});

// UNIFIED SPA MAIN ROUTE: Intercepts code parameters and cleans them dynamically
app.get('/', async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html')); 
    }

    const targetEmail = state ? state.toLowerCase().trim() : '';
    try {
        const { tokens } = await oauth2Client.getToken(code);
        if (targetEmail) {
            await supabase.from('users').upsert(
                { email: targetEmail, google_refresh_token: tokens.refresh_token }, 
                { onConflict: 'email' }
            );
        }
        return res.redirect(`/?login_success=true&email=${encodeURIComponent(targetEmail)}&google_linked=true`);
    } catch (err) {
        console.error("Auth Linkage failure:", err);
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// --- CORE PIPELINE AUDIO AUTOMATION GENERATOR (WITH DUP FILTERING) ---
app.post('/api/generate-brief', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { userTimezone, deviceClock, geoCoordinates } = req.body;

    try {
        const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
        if (error || !user || !user.google_refresh_token) return res.status(404).json({ error: "Google data synchronization missing." });

        let spatialWeatherResult = "Scattered clouds, ambient conditions.";
        if (geoCoordinates && geoCoordinates.lat && geoCoordinates.lon) {
            try {
                const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${geoCoordinates.lat}&longitude=${geoCoordinates.lon}&current_weather=true`;
                const weatherResponse = await fetch(weatherUrl);
                const weatherData = await weatherResponse.json();
                if (weatherData && weatherData.current_weather) {
                    spatialWeatherResult = `${weatherData.current_weather.temperature}°C with a local wind speed of ${weatherData.current_weather.windspeed} km/h.`;
                }
            } catch (wErr) {}
        }

        const userAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        userAuth.setCredentials({ refresh_token: user.google_refresh_token });

        const calendar = google.calendar({ version: 'v3', auth: userAuth });
        const gmail = google.gmail({ version: 'v1', auth: userAuth });

        const localNow = new Date(deviceClock);
        const endOfDay = new Date(deviceClock);
        endOfDay.setHours(23, 59, 59, 999);

        const { data: readLogs } = await supabase.from('read_briefing_logs').select('message_id').eq('user_email', email);
        const prohibitedIds = (readLogs || []).map(log => log.message_id);

        const [calendarData, gmailData] = await Promise.all([
            calendar.events.list({ calendarId: 'primary', timeMin: localNow.toISOString(), timeMax: endOfDay.toISOString(), singleEvents: true, orderBy: 'startTime' }),
            gmail.users.messages.list({ userId: 'me', q: 'is:starred', maxResults: 15 })
        ]);

        let customPriorityEmails = [];
        let freshLoggedIds = [];

        if (gmailData.data.messages) {
            for (let msg of gmailData.data.messages) {
                if (prohibitedIds.includes(msg.id)) continue;

                const content = await gmail.users.messages.get({ userId: 'me', id: msg.id });
                const headers = content.data.payload.headers;
                const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
                const subject = subjectHeader ? subjectHeader.value : "No Subject";
                
                customPriorityEmails.push({ id: msg.id, subject: subject, snippet: content.data.snippet });
                freshLoggedIds.push(msg.id);
                
                if (customPriorityEmails.length >= 3) break;
            }
        }

        const synchronizedCalendarEvents = calendarData.data.items.map(item => {
            const startRaw = item.start.dateTime || item.start.date;
            const formattedTime = new Date(startRaw).toLocaleTimeString(undefined, { timeZone: userTimezone, hour: '2-digit', minute: '2-digit' });
            return `${item.summary} starting exactly at ${formattedTime}`;
        });

        const consolidatedData = {
            currentTimeAndDate: deviceClock,
            regionalTargetTimezone: userTimezone,
            currentWeatherMetrics: spatialWeatherResult,
            calendar: synchronizedCalendarEvents,
            starredInboxSnippets: customPriorityEmails
        };

        const briefPrompt = `You are an elite executive chief of staff. Review this raw environment metric: ${JSON.stringify(consolidatedData)}.
        Compose a short spoken update. If starredInboxSnippets is completely empty, warmly inform the user that there are no new unread priority updates since their last briefing check.
        STRICT PROTOCOLS:
        1. You MUST start the script word-for-word with: "Good Morning, Boss."
        2. Do not use structural markdown elements or markdown bullets.`;

        let aiResponse = await generateContentWithRetry(briefPrompt);
        const scriptText = aiResponse.text;

        if (freshLoggedIds.length > 0) {
            const batchLogs = freshLoggedIds.map(id => ({ user_email: email, message_id: id }));
            await supabase.from('read_briefing_logs').insert(batchLogs);
        }

        const tts = new MsEdgeTTS();
        await tts.setMetadata('en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        
        const uniqueSubDirName = `brief-${Date.now()}`;
        const finalTargetDir = path.join(audioCacheDir, uniqueSubDirName);
        fs.mkdirSync(finalTargetDir, { recursive: true });
        await compileSpeechWithRetry(tts, finalTargetDir, scriptText);

        return res.json({ text: scriptText, streamUrl: `/audio/${uniqueSubDirName}/audio.mp3` });
    } catch (pipelineErr) {
        console.error("Pipeline breakdown:", pipelineErr);
        return res.status(500).json({ error: pipelineErr.message });
    }
});

// --- AGENT INTERACTIVE CONTROLLER ENDPOINT ---
app.post('/api/agent/chat', async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { userCommand } = req.body;

    try {
        const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
        if (error || !user) return res.status(404).json({ error: "User execution matrix sync missing." });

        const verifiedUserNameSignature = user.name || "Vaishnavi Somarouthu";

        const userAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        userAuth.setCredentials({ refresh_token: user.google_refresh_token });
        const gmail = google.gmail({ version: 'v1', auth: userAuth });

        const [starredRes, unstarredRes] = await Promise.all([
            gmail.users.messages.list({ userId: 'me', q: 'is:starred', maxResults: 20 }),
            gmail.users.messages.list({ userId: 'me', q: '-is:starred', maxResults: 30 })
        ]);

        let targetInboxContext = [];
        const combinedMessages = [
            ...(starredRes.data.messages || []).map(m => ({ ...m, status: 'starred' })),
            ...(unstarredRes.data.messages || []).map(m => ({ ...m, status: 'unstarred' }))
        ];

        for (let msg of combinedMessages) {
            try {
                const content = await gmail.users.messages.get({ userId: 'me', id: msg.id });
                const headers = content.data.payload.headers;
                const subject = (headers.find(h => h.name.toLowerCase() === 'subject') || {}).value || "No Subject";
                const fromSender = (headers.find(h => h.name.toLowerCase() === 'from') || {}).value || "Unknown Sender";
                const messageIdHeader = (headers.find(h => h.name.toLowerCase() === 'message-id') || {}).value || "";
                targetInboxContext.push({ 
                    id: msg.id, 
                    threadId: content.data.threadId, 
                    subject: subject, 
                    from: fromSender, 
                    messageIdHeader: messageIdHeader,
                    status: msg.status
                });
            } catch (e) { }
        }

        const commandResolutionPrompt = `You are BriefCase, an elite operational workspace automation agent processing this command: "${userCommand}".
        Review this live user inbox cache data context matrix containing both starred and unstarred records: ${JSON.stringify(targetInboxContext)}.
        
        CRITICAL CORE ACTIONS GUIDE:
        1. If the user wants to reply to an existing email, identify it from the dataset matrix. If the command also explicitly demands to STAR it first, mark "shouldStarTarget": true.
        2. If the user wants to star an email without replying, map action to "star".
        3. If the user wants to compose a fresh email from scratch to an email address mentioned in their prompt (and NOT reply to an existing context item), map action to "compose".
        
        CRITICAL SIGNATURE PROTOCOLS:
        - The account holder's name is strictly: "${verifiedUserNameSignature}".
        - When generating "replyDraftText", you MUST end the email signature exactly using either "Best regards, ${verifiedUserNameSignature}" or "Warm Regards, ${verifiedUserNameSignature}". Absolutely no other sign-off labels are permitted.

        OUTPUT PROTOCOL: Return ONLY a raw JSON string literal. Do NOT wrap it inside markdown backticks or markdown formatting labels.
        Format layout exactly:
        {
            "action": "reply" or "star" or "unstar" or "compose" or "none",
            "targetId": "the string message id matched or null",
            "threadId": "the string thread id matched or null",
            "recipient": "the email address to send the reply or new email to",
            "subject": "The email subject line",
            "messageIdHeader": "the original messageIdHeader value or null",
            "shouldStarTarget": true or false,
            "signOffPhrase": "Best regards," or "Warm Regards,",
            "replyDraftText": "Compose the complete, polished email message body text here. Stop immediately before the sign-off closing. Do NOT add signatures, names, or sign-offs inside this text block.",
            "agentNarration": "A short, elegant phrase speaking back to the user explaining the exact system action you just triggered."
        }`;

        let aiResponse = await generateContentWithRetry(commandResolutionPrompt);
        let resolution = JSON.parse(aiResponse.text.trim());
        
        if (resolution.action === 'star' || resolution.shouldStarTarget === true) {
            if (resolution.targetId) {
                await gmail.users.messages.modify({ userId: 'me', id: resolution.targetId, requestBody: { addLabelIds: ['STARRED'] } });
            }
        }

        if (resolution.action === 'unstar') {
            if (resolution.targetId) {
                await gmail.users.messages.modify({ userId: 'me', id: resolution.targetId, requestBody: { removeLabelIds: ['STARRED'] } });
            }
        }

        if ((resolution.action === 'reply' || resolution.action === 'compose') && resolution.recipient) {
            const pristineSignOff = resolution.signOffPhrase || "Best regards,";
            const structuralSignatureBlock = `${pristineSignOff}\n${verifiedUserNameSignature}`;
            
            const finishedEmailBody = `${resolution.replyDraftText}\n\n${structuralSignatureBlock}\n\n---\n*Automated message from BriefCase. If you feel anything's missing or it's urgent, please reach out directly or reply over here.*`;

            let rawMessageLines = [
                `To: ${resolution.recipient}`,
                `Subject: ${resolution.subject}`,
                `Content-Type: text/plain; charset=utf-8`,
            ];

            if (resolution.action === 'reply' && resolution.messageIdHeader) {
                rawMessageLines.push(`In-Reply-To: ${resolution.messageIdHeader}`);
                rawMessageLines.push(`References: ${resolution.messageIdHeader}`);
            }

            rawMessageLines.push(``);
            rawMessageLines.push(finishedEmailBody);
            
            const rawEmailString = rawMessageLines.join('\n');
            const encodedRawEmail = Buffer.from(rawEmailString).toString('base64url');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedRawEmail,
                    threadId: resolution.action === 'reply' ? resolution.threadId : undefined
                }
            });
        }

        const tts = new MsEdgeTTS();
        await tts.setMetadata('en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const uniqueSubDirName = `agent-${Date.now()}`;
        const finalTargetDir = path.join(audioCacheDir, uniqueSubDirName);
        fs.mkdirSync(finalTargetDir, { recursive: true });
        
        await compileSpeechWithRetry(tts, finalTargetDir, resolution.agentNarration);

        return res.json({ text: resolution.agentNarration, streamUrl: `/audio/${uniqueSubDirName}/audio.mp3` });
    } catch (err) {
        console.error("Agent interaction loop collapse:", err);
        return res.status(500).json({ error: err.message });
    }
});

// --- BACKGROUND AUTOMATION WORKER (CRON ENGINE) ---
async function runBackgroundAutoStarWorker() {
    try {
        const { data: users } = await supabase.from('users').select('email, google_refresh_token').not('google_refresh_token', 'is', null);
        if (!users) return;

        for (let user of users) {
            const { data: rules } = await supabase.from('auto_star_rules').select('*').eq('user_email', user.email);
            if (!rules || rules.length === 0) continue;

            const userAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            userAuth.setCredentials({ refresh_token: user.google_refresh_token });
            const gmail = google.gmail({ version: 'v1', auth: userAuth });

            const recentMessages = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 40 });
            if (!recentMessages.data.messages) continue;

            const existingLabelsRes = await gmail.users.labels.list({ userId: 'me' });
            const existingLabels = existingLabelsRes.data.labels || [];

            for (let msg of recentMessages.data.messages) {
                const content = await gmail.users.messages.get({ userId: 'me', id: msg.id });
                const headers = content.data.payload.headers;
                const fromSender = ((headers.find(h => h.name.toLowerCase() === 'from') || {}).value || '').toLowerCase();

                const matchingRule = rules.find(r => fromSender.includes(r.target_sender));
                if (matchingRule) {
                    const currentLabels = content.data.labelIds || [];
                    if (!currentLabels.includes('STARRED')) {
                        let labelIdToApply = null;
                        const targetLabelName = matchingRule.custom_label;

                        let foundLabel = existingLabels.find(l => l.name.toLowerCase() === targetLabelName.toLowerCase());
                        if (!foundLabel) {
                            try {
                                const createdLabel = await gmail.users.labels.create({ userId: 'me', requestBody: { name: targetLabelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
                                labelIdToApply = createdLabel.data.id;
                                existingLabels.push(createdLabel.data);
                            } catch (lblErr) {}
                        } else { labelIdToApply = foundLabel.id; }

                        const modifyPayload = { addLabelIds: ['STARRED'] };
                        if (labelIdToApply) modifyPayload.addLabelIds.push(labelIdToApply);

                        await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: modifyPayload });
                    }
                }
            }
        }
    } catch (workerErr) {}
}
setInterval(runBackgroundAutoStarWorker, 30000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(" BriefCase Production Engine Active on Port " + PORT);
});