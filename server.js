const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cron = require("node-cron");
const fs = require("fs"); // Built-in file system module
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const { TUYA_CLIENT_ID, TUYA_SECRET, TUYA_ENDPOINT, PORT, NTFY_TOPIC } = process.env;

// Path to the local JSON storage file
const DATA_FILE = path.join(__dirname, "devices.json");

// Global Server-Side Storage for Tracking Devices
let trackedDevices = []; 

// Helper function to load devices from the JSON file on startup
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

// Helper function to save devices to the JSON file whenever changes happen
function saveDevicesToFile() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(trackedDevices, null, 2), "utf8");
        console.log("💾 Device list successfully saved to devices.json.");
    } catch (error) {
        console.error("❌ Error writing to devices.json file:", error.message);
    }
}

// Trigger initial configuration load on boot
loadDevicesFromFile();

// Cache for device data to serve the frontend quickly
let sensorDataCache = {};

// Simple Token Cache to protect Tuya rate limits
let tokenCache = {
    token: null,
    expiresAt: 0
};

// Track state changes to prevent notification spamming
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

// Physics Math: Calculate Absolute Humidity (g/m³)
function getAbsoluteHumidity(temp, rh) {
    if (temp === "N/A" || rh === "N/A" || temp === null || rh === null) return nulvgl;
    const es = 6.112 * Math.exp((17.67 * temp) / (temp + 243.5));
    const e = es * (rh / 100);
    const ah = (e * 216.7) / (temp + 273.15);
    return parseFloat(ah.toFixed(1));
}

// Helper to fetch data and compute absolute humidity for a single device
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

// Send alert to ntfy.sh mobile app
async function sendPushNotification(title, message) {
    if (!NTFY_TOPIC) {
        console.log("⚠️ NTFY_TOPIC not configured in .env. Skipping push notification.");
        return;
    }
    try {
        await axios.post(`https://ntfy.sh/${NTFY_TOPIC}`, message, {
            headers: { "Title": title }
        });
        console.log(`🚀 Notification sent via ntfy: [${title}] ${message}`);
    } catch (error) {
        console.error("❌ Failed to send ntfy notification:", error.message);
    }
}

// Background Evaluation Worker (Runs every 10 minutes)
async function evaluateHumidityAlerts() {
    console.log("🔄 Background check starting: evaluating humidity differences...");
    try {
        const outdoorDev = trackedDevices.find(d => d.type === "outdoor");
        if (!outdoorDev) return;

        // Refresh outdoor metrics
        const outdoorData = await processDeviceData(outdoorDev.id);
        sensorDataCache[outdoorDev.id] = outdoorData;

        if (!outdoorData.absoluteHumidity) return;

        // Process all indoor sensors
        const indoorDevices = trackedDevices.filter(d => d.type === "indoor");
        for (const dev of indoorDevices) {
            const indoorData = await processDeviceData(dev.id);
            sensorDataCache[dev.id] = indoorData;

            if (!indoorData.absoluteHumidity) continue;

            const diff = (indoorData.absoluteHumidity - outdoorData.absoluteHumidity).toFixed(1);
            const shouldOpen = indoorData.absoluteHumidity > outdoorData.absoluteHumidity;
            const targetState = shouldOpen ? "OPEN" : "CLOSE";

            // Check if the recommendation state shifted since last broadcast
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

// Run analysis loop every 10 minutes
cron.schedule("*/10 * * * *", evaluateHumidityAlerts);

// --- API ENDPOINTS FOR FRONTEND ---

// Get list of tracked devices
app.get("/api/devices", (req, res) => {
    res.json({ success: true, devices: trackedDevices });
});

// Add a device
app.post("/api/devices", (req, res) => {
    const { id, name, type } = req.body;
    if (!id || !name || !type) return res.status(400).json({ success: false, error: "Missing fields" });
    
    if (type === "outdoor" && trackedDevices.some(d => d.type === "outdoor")) {
        return res.status(400).json({ success: false, error: "An outdoor device already exists" });
    }

    trackedDevices.push({ id, name, type });
    saveDevicesToFile(); // Persist changes to disk
    res.json({ success: true, devices: trackedDevices });
});

// Remove a device
app.delete("/api/devices/:id", (req, res) => {
    const { id } = req.params;
    trackedDevices = trackedDevices.filter(d => d.id !== id);
    delete sensorDataCache[id];
    delete lastNotificationStates[id];
    saveDevicesToFile(); // Persist changes to disk
    res.json({ success: true, devices: trackedDevices });
});

// Fetch current metrics dashboard data
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

// Legacy single route compat layer
app.get("/api/sensor/:deviceId", async (req, res) => {
    try {
        const data = await processDeviceData(req.params.deviceId);
        res.json({ success: true, ...data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => console.log(`Absolute Humidity Advisor Server running on http://localhost:${PORT}`));
