const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cron = require("node-cron");
const fs = require("fs"); 
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const { TUYA_CLIENT_ID, TUYA_SECRET, TUYA_ENDPOINT, PORT, NTFY_TOPIC } = process.env;

const DATA_FILE = path.join(__dirname, "devices.json");
const HISTORY_FILE = path.join(__dirname, "history.csv"); // New local CSV storage

let trackedDevices = []; 

// Initialize CSV with headers if it doesn't exist
if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, "timestamp,deviceId,temperature,humidity,absoluteHumidity\n", "utf8");
    console.log("ℹ️ Created new history.csv file for data logging.");
}

function loadDevicesFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, "utf8");
            trackedDevices = JSON.parse(data);
            console.log(`💾 Successfully loaded ${trackedDevices.length} devices from local storage file.`);
        } else {
            trackedDevices = [];
            console.log("ℹ️ No local storage file found. Initializing empty device list.");
        }
    } catch (error) {
        console.error("❌ Error reading devices.json file:", error.message);
        trackedDevices = [];
    }
}

function saveDevicesToFile() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(trackedDevices, null, 2), "utf8");
        console.log("💾 Device list successfully saved to devices.json.");
    } catch (error) {
        console.error("❌ Error writing to devices.json file:", error.message);
    }
}

// Write a single data point to the CSV
function logDataToCSV(deviceId, data) {
    if (!data || data.temperature === "N/A" || data.temperature === null) return;
    const timestamp = new Date().toISOString();
    const csvLine = `${timestamp},${deviceId},${data.temperature},${data.humidity},${data.absoluteHumidity}\n`;
    try {
        fs.appendFileSync(HISTORY_FILE, csvLine, "utf8");
    } catch (e) {
        console.error(`❌ Error writing to history.csv for device ${deviceId}:`, e.message);
    }
}

loadDevicesFromFile();

let sensorDataCache = {};
let tokenCache = { token: null, expiresAt: 0 };
let lastNotificationStates = {}; 

function calculateSign(clientId, secret, timestamp, accessToken, stringToSign) {
    const str = clientId + (accessToken ? accessToken : "") + timestamp + stringToSign;
    return crypto.createHmac("sha256", secret).update(str).digest("hex").toUpperCase();
}

async function makeTuyaRequest(method, path, useToken = true) {
    let accessToken = null;

    if (useToken) {
        const now = Date.now();
        if (tokenCache.token && tokenCache.expiresAt > now) {
            accessToken = tokenCache.token;
        } else {
            const tokenResult = await makeTuyaRequest("GET", "/v1.0/token?grant_type=1", false);
            tokenCache.token = tokenResult.access_token;
            tokenCache.expiresAt = now + (tokenResult.expire_time * 1000) - 60000;
            accessToken = tokenCache.token;
        }
    }

    const timestamp = Date.now().toString();
    const uppercaseMethod = method.toUpperCase();
    const contentHash = crypto.createHash("sha256").update("").digest("hex");
    const stringToSign = [uppercaseMethod, contentHash, "", path].join("\n");
    
    const sign = calculateSign(TUYA_CLIENT_ID, TUYA_SECRET, timestamp, accessToken, stringToSign);

    const headers = {
        "client_id": TUYA_CLIENT_ID,
        "sign": sign,
        "t": timestamp,
        "sign_method": "HMAC-SHA256",
    };
    if (accessToken) headers["access_token"] = accessToken;

    const response = await axios({ method: uppercaseMethod, url: `${TUYA_ENDPOINT}${path}`, headers });

    if (!response.data.success) {
        throw new Error(`[Tuya Error ${response.data.code}]: ${response.data.msg}`);
    }
    return response.data.result;
}

function getAbsoluteHumidity(temp, rh) {
    if (temp === "N/A" || rh === "N/A" || temp === null || rh === null) return null;
    const es = 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
    const e = es * (rh / 100);
    const ah = (e * 216.7) / (temp + 273.15);
    return parseFloat(ah.toFixed(1));
}

async function processDeviceData(deviceId) {
    const statusResult = await makeTuyaRequest("GET", `/v1.0/devices/${deviceId}/status`);
    let temperature = "N/A";
    let humidity = "N/A";

    statusResult.forEach(item => {
        if (item.code === "va_temperature" || item.code === "temp_current") {
            temperature = item.value / 10; 
        }
        if (item.code === "va_humidity" || item.code === "humidity_value") {
            humidity = item.value;
        }
    });

    const absoluteHumidity = getAbsoluteHumidity(temperature, humidity);
    return { temperature, humidity, absoluteHumidity, deviceId };
}

async function sendPushNotification(title, message) {
    if (!NTFY_TOPIC) return;
    try {
        await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, message, { headers: { "Title": title } });
    } catch (error) {
        console.error("❌ Failed to send ntfy notification:", error.message);
    }
}

async function evaluateHumidityAlerts() {
    try {
        const outdoorDev = trackedDevices.find(d => d.type === "outdoor");
        let outdoorData = null;

        if (outdoorDev) {
            outdoorData = await processDeviceData(outdoorDev.id);
            sensorDataCache[outdoorDev.id] = outdoorData;
            logDataToCSV(outdoorDev.id, outdoorData); // Log outdoor data to CSV
        }

        const indoorDevices = trackedDevices.filter(d => d.type === "indoor");
        for (const dev of indoorDevices) {
            const indoorData = await processDeviceData(dev.id);
            sensorDataCache[dev.id] = indoorData;
            logDataToCSV(dev.id, indoorData); // Log indoor data to CSV

            // Only trigger alert logic if we have both absolute humidities available
            if (!indoorData.absoluteHumidity || !outdoorData || !outdoorData.absoluteHumidity) continue;

            const diff = (indoorData.absoluteHumidity - outdoorData.absoluteHumidity).toFixed(1);
            const shouldOpen = indoorData.absoluteHumidity > outdoorData.absoluteHumidity;
            const targetState = shouldOpen ? "OPEN" : "CLOSE";

            if (lastNotificationStates[dev.id] !== targetState) {
                lastNotificationStates[dev.id] = targetState;
                const title = `Absolute Humidity Advisor: ${dev.name}`;
                const body = shouldOpen 
                    ? `OPEN window! ${Math.abs(diff)} g/m³ less moisture outside.`
                    : `CLOSE window! ${Math.abs(diff)} g/m³ more moisture outside.`;

                await sendPushNotification(title, body);
            }
        }
    } catch (error) {
        console.error("❌ Error running background evaluation:", error.message);
    }
}

// Background Evaluation Worker & Logger (Runs every 10 minutes)
cron.schedule("*/10 * * * *", evaluateHumidityAlerts);

// --- API ENDPOINTS ---

app.get("/api/devices", (req, res) => {
    res.json({ success: true, devices: trackedDevices });
});

app.post("/api/devices", (req, res) => {
    const { id, name, type } = req.body;
    if (!id || !name || !type) return res.status(400).json({ success: false, error: "Missing fields" });
    if (type === "outdoor" && trackedDevices.some(d => d.type === "outdoor")) {
        return res.status(400).json({ success: false, error: "An outdoor device already exists" });
    }
    trackedDevices.push({ id, name, type });
    saveDevicesToFile(); 
    res.json({ success: true, devices: trackedDevices });
});

app.delete("/api/devices/:id", (req, res) => {
    const { id } = req.params;
    trackedDevices = trackedDevices.filter(d => d.id !== id);
    delete sensorDataCache[id];
    delete lastNotificationStates[id];
    saveDevicesToFile(); 
    res.json({ success: true, devices: trackedDevices });
});

app.get("/api/dashboard", async (req, res) => {
    try {
        for (const dev of trackedDevices) {
            try {
                sensorDataCache[dev.id] = await processDeviceData(dev.id);
            } catch (e) {
                console.error(`Could not update data for ${dev.name}:`, e.message);
            }
        }
        res.json({ success: true, cache: sensorDataCache });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// NEW: Real Historical Data Endpoint (Parses and aggregates CSV)
app.get("/api/history/:id", (req, res) => {
    const { id } = req.params;
    const { metric, window } = req.query; 

    if (!fs.existsSync(HISTORY_FILE)) {
        return res.json({ success: true, data: { labels: [], points: [] } });
    }

    const now = new Date();
    let cutoffDate = new Date();
    let groupFormat = 'hour'; // default grouping

    // Set cutoff limits and grouping strategy to prevent crashing the frontend chart
    if (window === '1w') {
        cutoffDate.setDate(now.getDate() - 7);
        groupFormat = 'hour'; // Average per hour
    } else if (window === '1mo') {
        cutoffDate.setMonth(now.getMonth() - 1);
        groupFormat = 'day'; // Average per day
    } else if (window === '1y') {
        cutoffDate.setFullYear(now.getFullYear() - 1);
        groupFormat = 'month'; // Average per month
    }

    try {
        const fileContent = fs.readFileSync(HISTORY_FILE, "utf8");
        const lines = fileContent.trim().split("\n");
        let groupedData = {};

        // Skip the header row (i = 1)
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            
            const [ts, devId, temp, hum, absHum] = lines[i].split(",");
            if (devId !== id) continue; // Only process the requested device

            const dateObj = new Date(ts);
            if (dateObj < cutoffDate) continue; // Ignore old data outside the requested window

            // Select requested metric
            let val = 0;
            if (metric === 'temperature') val = parseFloat(temp);
            else if (metric === 'humidity') val = parseFloat(hum);
            else if (metric === 'absoluteHumidity') val = parseFloat(absHum);

            if (isNaN(val)) continue;

            // Grouping logic based on time window
            let groupKey = "";
            let label = "";
            
            if (groupFormat === 'hour') {
                groupKey = `${dateObj.getFullYear()}-${dateObj.getMonth()+1}-${dateObj.getDate()}-${dateObj.getHours()}`;
                label = `${dateObj.getDate()}/${dateObj.getMonth()+1} ${dateObj.getHours()}:00`;
            } else if (groupFormat === 'day') {
                groupKey = `${dateObj.getFullYear()}-${dateObj.getMonth()+1}-${dateObj.getDate()}`;
                label = `${dateObj.getDate()}/${dateObj.getMonth()+1}`;
            } else { // month
                groupKey = `${dateObj.getFullYear()}-${dateObj.getMonth()+1}`;
                label = dateObj.toLocaleString('default', { month: 'short', year: '2-digit' });
            }

            // Accumulate for averaging
            if (!groupedData[groupKey]) {
                groupedData[groupKey] = { label, sum: 0, count: 0, time: dateObj.getTime() };
            }
            groupedData[groupKey].sum += val;
            groupedData[groupKey].count += 1;
        }

        // Sort chronologically
        const sortedGroups = Object.values(groupedData).sort((a, b) => a.time - b.time);

        // Extract final labels and average values
        const labels = sortedGroups.map(g => g.label);
        const points = sortedGroups.map(g => parseFloat((g.sum / g.count).toFixed(1)));

        res.json({ success: true, data: { labels, points } });

    } catch (error) {
        console.error("❌ Error processing history:", error.message);
        res.status(500).json({ success: false, error: "Failed to read history" });
    }
});

app.listen(PORT, () => console.log(`Absolute Humidity Advisor Server running on http://localhost:${PORT}`));