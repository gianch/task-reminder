/**
 * check-reminders.js
 *
 * Runs on a GitHub Actions cron schedule every 5 minutes.
 * Reads tasks from Firestore, sends WhatsApp via CallMeBot for any
 * whose reminderTime has passed and haven't been notified yet,
 * then marks them as notified so they never double-fire.
 */

const admin = require('firebase-admin');
const https = require('https');

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
});

const db = admin.firestore();

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    // 1. Load WhatsApp credentials from Firestore (same source as the web app)
    const settingsDoc = await db.collection('config').doc('settings').get();

    if (!settingsDoc.exists) {
        console.log('No settings document found — skipping.');
        return;
    }

    const { whatsappPhone, apiKey } = settingsDoc.data();

    if (!whatsappPhone || !apiKey) {
        console.log('WhatsApp credentials not configured — skipping.');
        return;
    }

    // 2. Query tasks that haven't been notified yet
    const snapshot = await db.collection('tasks')
        .where('notified', '==', false)
        .get();

    if (snapshot.empty) {
        console.log('No pending reminders.');
        return;
    }

    const now = new Date();
    const batch = db.batch();
    let sent = 0;

    // 3. For each due task, send WhatsApp and mark notified
    for (const doc of snapshot.docs) {
        const task = doc.data();
        const reminderTime = new Date(task.reminderTime);

        if (now < reminderTime) continue; // not due yet

        console.log(`Sending reminder for: "${task.title}" (due ${reminderTime.toISOString()})`);

        try {
            await sendWhatsApp(task, whatsappPhone, apiKey);
            batch.update(doc.ref, { notified: true });
            sent++;
        } catch (err) {
            console.error(`Failed to send for "${task.title}":`, err.message);
            // Don't mark notified — will retry next run
        }
    }

    // 4. Commit all notified=true updates in one round-trip
    if (sent > 0) {
        await batch.commit();
        console.log(`✓ Sent ${sent} reminder(s).`);
    } else {
        console.log('No reminders were due.');
    }

    // 5. Clean up archived tasks older than 30 days
    await cleanupArchived();
}

// ── WhatsApp via CallMeBot ────────────────────────────────────────────────────
function sendWhatsApp(task, phone, apiKey) {
    const taskDate = new Date(task.datetime);
    const dateStr  = taskDate.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const message =
        `🔔 REMINDER: ${task.title}\n\n` +
        (task.description ? task.description + '\n\n' : '') +
        `📅 Scheduled: ${dateStr}`;

    const url =
        `https://api.callmebot.com/whatsapp.php` +
        `?phone=${encodeURIComponent(phone)}` +
        `&text=${encodeURIComponent(message)}` +
        `&apikey=${encodeURIComponent(apiKey)}`;

    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let body = '';
            res.on('data', chunk => (body += chunk));
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(body);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
                }
            });
        }).on('error', reject);
    });
}

// ── Auto-delete archived tasks older than 30 days ────────────────────────────
async function cleanupArchived() {
    const snapshot = await db.collection('tasks')
        .where('archived', '==', true)
        .get();

    if (snapshot.empty) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    const toDelete = snapshot.docs.filter(doc => {
        const at = doc.data().archivedAt;
        return at && new Date(at) < cutoff;
    });

    if (toDelete.length === 0) {
        console.log('No archived tasks old enough to delete.');
        return;
    }

    const batch = db.batch();
    toDelete.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`🗑  Deleted ${toDelete.length} archived task(s) older than 30 days.`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
main()
    .catch(err => { console.error('Fatal:', err); process.exit(1); })
    .finally(() => process.exit(0));
