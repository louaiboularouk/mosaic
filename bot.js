const https = require('https');
const http = require('http');

// ========== Configuration ==========
const TELEGRAM_TOKEN = '7352641204:AAHKyuxRgNzKvg1HA5hioBP3hGOa7vt3M2k';
const TELEGRAM_CHAT_ID = '-1002496672875';
const CHECK_INTERVAL_MS = 1000; // كل1 ثواني
const PORT = process.env.PORT || 3000;

// URLs to monitor
const URLS = [
    { url: 'https://appointment.mosaicvisa.com/calendar/9', label: 'أفريل 2026', maxDay: null },
    { url: 'https://appointment.mosaicvisa.com/calendar/9?month=2026-05', label: 'ماي 2026', maxDay: 7 }
];

// Track already notified dates to avoid spam
const notifiedDates = new Set();

// Stats
let totalChecks = 0;
let totalAlerts = 0;
let lastCheckTime = null;
let lastStatus = 'Starting...';

// ========== Timestamp ==========
function timestamp() {
    return new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
}

// ========== Telegram ==========
function sendToTelegram(message) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.ok) {
                        resolve(true);
                    } else {
                        reject(new Error(parsed.description || 'Telegram error'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ========== Fetch HTML ==========
function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            }
        }, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchHTML(res.headers.location).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ========== Parse Calendar HTML ==========
// HTML structure per row:
// <tr\nclass="calendar-dates" style="..."><td><strong>DATE</strong></td><td><h6 class='text-center'>Available <b><i class='fa fa-user ml-2'></i> NUMBER</b></h6></td></tr>
// Some dates have empty <td></td> (no slots info at all)
function parseCalendar(html, maxDay) {
    const results = [];

    // Normalize: remove newlines so <tr ...> is on one line
    const normalized = html.replace(/\r?\n/g, ' ');

    // Match each calendar-dates row
    const rowRegex = /<tr\s+class="calendar-dates"[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;

    while ((match = rowRegex.exec(normalized)) !== null) {
        const rowContent = match[1];

        // Extract date
        const dateMatch = rowContent.match(/<strong>\s*(\d{1,2}\s+\w+\s+\d{4})\s*<\/strong>/i);
        if (!dateMatch) continue;

        const dateStr = dateMatch[1].trim();

        // Filter by maxDay if set
        if (maxDay !== null) {
            const dayMatch = dateStr.match(/^(\d{1,2})/);
            if (dayMatch) {
                const day = parseInt(dayMatch[1], 10);
                if (day > maxDay) continue;
            }
        }

        // Check for Available/Reserved and extract count
        const availableMatch = rowContent.match(/Available\s*<b[^>]*>.*?(\d+)/i);
        const reservedMatch = rowContent.match(/Reserved\s*<b[^>]*>.*?(\d+)/i);

        let status = 'empty'; // no info
        let slots = 0;

        if (availableMatch) {
            status = 'available';
            slots = parseInt(availableMatch[1], 10);
        } else if (reservedMatch) {
            status = 'reserved';
            slots = parseInt(reservedMatch[1], 10);
        }

        results.push({
            date: dateStr,
            status,
            slots,
            hasSlots: slots > 0 && status === 'available'
        });
    }

    return results;
}

// ========== Main Check ==========
async function checkAvailability() {
    totalChecks++;
    const foundSlots = [];

    for (const { url, label, maxDay } of URLS) {
        try {
            const html = await fetchHTML(url);
            const calendar = parseCalendar(html, maxDay);

            for (const entry of calendar) {
                if (entry.hasSlots) {
                    entry.monthLabel = label;
                    foundSlots.push(entry);
                }
            }

            // Log parsed count for debugging
            if (totalChecks <= 3) {
                console.log(`   📋 ${label}: ${calendar.length} تواريخ محللة`);
            }
        } catch (e) {
            console.log(`[${timestamp()}] ❌ خطأ في جلب ${label}: ${e.message}`);
        }
    }

    lastCheckTime = timestamp();

    if (foundSlots.length > 0) {
        // Filter out already notified
        const newSlots = foundSlots.filter(s => !notifiedDates.has(s.date));

        if (newSlots.length > 0) {
            totalAlerts++;
            lastStatus = `🟢 وُجدت مواعيد متاحة! (${newSlots.length})`;

            let message = `🚨🚨🚨 تنبيه عاجل - مواعيد متاحة! 🚨🚨🚨\n\n`;
            message += `📍 Mosaic Visa - Algiers\n\n`;

            for (const slot of newSlots) {
                message += `📅 ${slot.date}\n`;
                message += `✅ متاح: ${slot.slots} مكان\n\n`;
                notifiedDates.add(slot.date);
            }

            message += `⏰ ${timestamp()}\n`;
            message += `🔗 احجز: https://appointment.mosaicvisa.com/calendar/9`;

            console.log(`[${timestamp()}] 🟢 وُجدت ${newSlots.length} تواريخ متاحة!`);
            for (const slot of newSlots) {
                console.log(`   📅 ${slot.date} - ${slot.slots} مكان`);
            }

            try {
                await sendToTelegram(message);
                console.log(`[${timestamp()}] ✅ تم إرسال إشعار تلغرام!`);
            } catch (e) {
                console.log(`[${timestamp()}] ❌ فشل تلغرام: ${e.message}`);
                for (const slot of newSlots) {
                    notifiedDates.delete(slot.date);
                }
            }
        } else {
            lastStatus = `🟡 متاحة (تم الإشعار)`;
            if (totalChecks % 60 === 0) {
                console.log(`[${timestamp()}] 🟡 متاحة لكن تم الإشعار - فحص #${totalChecks}`);
            }
        }
    } else {
        lastStatus = `🔴 لا مواعيد متاحة`;
        console.log(`[${timestamp()}] 🔴 لا مواعيد متاحة - فحص #${totalChecks}`);
    }
}

// ========== Reset notified dates every 30 min ==========
setInterval(() => {
    notifiedDates.clear();
    console.log(`[${timestamp()}] 🔄 تم إعادة تعيين التنبيهات`);
}, 30 * 60 * 1000);

// ========== HTTP Server for Render (keep alive) ==========
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
            <meta charset="UTF-8">
            <title>Mosaic Visa Bot</title>
            <meta http-equiv="refresh" content="10">
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 40px; }
                .container { max-width: 600px; margin: 0 auto; background: #16213e; border-radius: 16px; padding: 30px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
                h1 { color: #00d4ff; text-align: center; }
                .stat { background: #0f3460; padding: 15px; border-radius: 10px; margin: 10px 0; }
                .stat span { color: #00d4ff; font-weight: bold; }
                .status { font-size: 1.2em; text-align: center; padding: 20px; background: #0f3460; border-radius: 10px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 بوت مراقبة Mosaic Visa</h1>
                <div class="status">${lastStatus}</div>
                <div class="stat">📊 عدد الفحوصات: <span>${totalChecks}</span></div>
                <div class="stat">🔔 عدد التنبيهات: <span>${totalAlerts}</span></div>
                <div class="stat">⏰ آخر فحص: <span>${lastCheckTime || 'لم يبدأ بعد'}</span></div>
                <div class="stat">⏱️ الفاصل: <span>${CHECK_INTERVAL_MS / 1000} ثواني</span></div>
            </div>
        </body>
        </html>
    `);
});

server.listen(PORT, () => {
    console.log('='.repeat(55));
    console.log('🤖 بوت مراقبة Mosaic Visa - مواعيد الفيزا');
    console.log(`⏱️  الفحص كل ${CHECK_INTERVAL_MS / 1000} ثواني`);
    console.log(`📱 تلغرام: ${TELEGRAM_CHAT_ID}`);
    console.log(`🌐 المنفذ: ${PORT}`);
    console.log('='.repeat(55));
    console.log(`[${timestamp()}] 🚀 بدء المراقبة...\n`);

    // First check immediately
    checkAvailability();

    // Then every X seconds
    setInterval(checkAvailability, CHECK_INTERVAL_MS);
});
