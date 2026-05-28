// server.js - Agricultural Supply Chain API Server with Database Integration
const express = require("express");
const { Gateway, Wallets } = require("fabric-network");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient, Prisma } = require("@prisma/client");
const multer = require("multer");
const nodemailer = require("nodemailer");
const axios = require("axios");
const { time } = require("console");

// Initialize Prisma
const prisma = new PrismaClient();
async function updateGeometryPoint(tableName, id, lat, lng) {
  // Check if coordinates exist
  if (lat === undefined || lng === undefined || lat === null || lng === null) {
    return;
  }
  const srid = 4326; // WGS 84 spatial reference system

  try {
    // ✅ CRITICAL FIX: Explicitly cast the SRID parameter to INTEGER
    // and ensure ST_MakePoint result is cast to GEOMETRY before ST_SetSRID.
    await prisma.$executeRaw(Prisma.sql`
                UPDATE ${Prisma.raw(tableName)}
                SET geom_point = public.ST_SetSRID(
                    public.ST_MakePoint(${lng}::double precision, ${lat}::double precision)::geometry, 
                    ${srid}::integer
                )::geography
                WHERE id = ${id}
            `);
    console.log(`✅ PostGIS: Updated geometry for ${tableName} ID ${id}`);
  } catch (error) {
    // This MUST re-throw so the main route can catch the error and respond once.
    console.error(`❌ PostGIS Error updating ${tableName}:`, error.message);
    throw error;
  }
}
/**
 * Creates a record in the BatchLocationHistory table and updates the PostGIS geometry.
 * @param {string} batchId
 * @param {string} eventType
 * @param {number} lat
 * @param {number} lng
 * @param {object} [metadata=null]
 */
async function logBatchLocation(batchId, eventType, lat, lng, metadata = null) {
  if (!lat || !lng) {
    console.warn(
      `Cannot log location history for batch ${batchId}: Coordinates missing.`
    );
    return null;
  }

  try {
    const historyRecord = await prisma.batchLocationHistory.create({
      data: {
        batchId: batchId,
        eventType: eventType,
        latitude: lat,
        longitude: lng,
        metadata: metadata || Prisma.DbNull,
      },
    });

    const srid = 4326;
    await prisma.$executeRaw(Prisma.sql`
            UPDATE "batch_location_history"
            SET geom_point = public.ST_SetSRID(
                public.ST_MakePoint(${lng}::double precision, ${lat}::double precision)::geometry, 
                ${srid}::integer
            )::geography
            WHERE id = ${historyRecord.id}
        `);

    console.log(
      `Logged location history event: ${eventType} for Batch ${batchId}`
    );
    return historyRecord;
  } catch (error) {
    console.error(
      `Error logging location history for batch ${batchId}:`,
      error.message
    );
    return null;
  }
}

async function getORSRoute(origin, destination, retryCount = 0) {
  const apiKey = process.env.ORS_API_KEY;
  const MAX_RETRIES = 3;
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3000));
  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${apiKey}&start=${origin.lng},${origin.lat}&end=${destination.lng},${destination.lat}`;

  try {
    const response = await axios.get(url, { timeout: 8000 });
    const route = response.data.features[0];

    return {
      durationMinutes: Math.round(route.properties.summary.duration / 60),
      distanceKm: (route.properties.summary.distance / 1000).toFixed(2),
      geometry: JSON.stringify(route.geometry),
      source: "ORS_API",
    };
  } catch (error) {
    if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
      const waitTime = Math.pow(2, retryCount) * 2000; // 2s, 4s, 8s...
      console.warn(
        `ORS Rate Limit hit. Retrying in ${waitTime}ms (Attempt ${
          retryCount + 1
        })...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return getORSRoute(origin, destination, retryCount + 1);
    }
    console.error(
      "Routing failed/throttled. Falling back to straight-line geometry."
    );

    const fallbackDist = calculateDirectDistance(
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng
    );

    return {
      durationMinutes: Math.round(fallbackDist * 1.5), // Estimate: ~1.5 min per km
      distanceKm: fallbackDist.toFixed(2),
      geometry: JSON.stringify({
        type: "LineString",
        coordinates: [
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
        ],
      }),
      source: "FALLBACK_DIRECT",
    };
  }
}
function calculateDirectDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// ML SERVICE INTEGRATION - Fraud Detection & Anomaly Detection
// ============================================================================

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:5000";
const ML_SERVICE_ENABLED = process.env.ML_SERVICE_ENABLED === "true";

/**
 * Check if ML service is available
 * @returns {Promise<boolean>}
 */
async function checkMLService() {
  if (!ML_SERVICE_ENABLED) {
    return false;
  }

  try {
    const response = await axios.get(`${ML_SERVICE_URL}/health`, {
      timeout: 2000,
    });
    return response.data.status === "healthy";
  } catch (error) {
    console.warn("⚠️  ML Service not available:", error.message);
    return false;
  }
}

/**
 * Validate batch data using ML anomaly detection
 * @param {Object} batchData - Batch information to validate
 * @returns {Promise<Object|null>} ML validation result or null if service unavailable
 */
async function validateBatchWithML(batchData) {
  const mlAvailable = await checkMLService();

  if (!mlAvailable) {
    console.log("ℹ️  ML validation skipped - service not available");
    return null;
  }

  try {
    console.log("🤖 Validating batch with ML fraud detection...");

    const mlPayload = {
      batchId: batchData.batchId || "UNKNOWN",
      crop: batchData.crop || batchData.productType,
      quantity: parseFloat(batchData.quantity) || 0,
      pricePerUnit: parseFloat(batchData.pricePerUnit) || 0,
      latitude: parseFloat(batchData.latitude) || 0,
      longitude: parseFloat(batchData.longitude) || 0,
      temperature: parseFloat(batchData.temperature) || 28,
      humidity: parseFloat(batchData.humidity) || 75,
      moistureContent: parseFloat(batchData.moistureContent) || 12,
      qualityGrade: batchData.qualityGrade || "B",
      weather_main: batchData.weather_main || "Clear",
    };

    const response = await axios.post(
      `${ML_SERVICE_URL}/api/ml/anomaly-check`,
      mlPayload,
      { timeout: 5000 }
    );

    const mlResult = response.data;

    // Log ML validation result
    if (mlResult.isAnomaly) {
      console.warn("⚠️  ML ANOMALY DETECTED:", {
        batchId: mlPayload.batchId,
        score: mlResult.anomalyScore,
        risk: mlResult.riskLevel,
        flags: mlResult.flags,
      });
    } else {
      console.log("✅ ML Validation passed:", {
        batchId: mlPayload.batchId,
        score: mlResult.anomalyScore,
        risk: mlResult.riskLevel,
      });
    }

    return mlResult;
  } catch (error) {
    console.error("❌ ML validation error:", error.message);
    // Don't fail the request if ML service fails - graceful degradation
    return null;
  }
}

/**
 * Get detailed fraud score for a batch
 * @param {Object} batchData - Batch information
 * @returns {Promise<Object|null>}
 */
async function getFraudScore(batchData) {
  const mlAvailable = await checkMLService();

  if (!mlAvailable) {
    return null;
  }

  try {
    const response = await axios.post(
      `${ML_SERVICE_URL}/api/ml/fraud-score`,
      batchData,
      { timeout: 5000 }
    );

    return response.data;
  } catch (error) {
    console.error("❌ Fraud score calculation error:", error.message);
    return null;
  }
}

/**
 * Fetches the Latitude and Longitude for any given spatial entity record ID.
 * @param {string} recordId // the user id
 * @param {string} entityType //user name
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function getCoordinates(recordId, entityType) {
  let model;
  let latField = "latitude";
  let lngField = "longitude";

  // Map the string entityType to the correct Prisma model instance
  switch (entityType) {
    case "FarmLocation":
      model = prisma.farmLocation;
      break;
    case "ProcessingFacility":
      model = prisma.processingFacility;
      break;
    case "DistributorProfile":
      model = prisma.distributorProfile;
      break;
    case "RetailerProfile":
      model = prisma.retailerProfile;
      break;
    default:
      console.error(`Unknown entity type: ${entityType}`);
      return null;
  }
  try {
    const record = await model.findUnique({
      where: { id: recordId },
      // Dynamically select the latitude and longitude fields
      select: { [latField]: true, [lngField]: true },
    });

    if (record && record[latField] !== null && record[lngField] !== null) {
      return {
        lat: parseFloat(record[latField]),
        lng: parseFloat(record[lngField]),
      };
    }
    return null;
  } catch (error) {
    console.error(
      `Error fetching coordinates for ${entityType}:`,
      error.message
    );
    return null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Helper function: Retry logic for MVCC conflicts
async function retryOnMVCCConflict(fn, maxRetries = 3, delayMs = 500) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isMVCCConflict =
        error.message && error.message.includes("MVCC_READ_CONFLICT");
      const isLastAttempt = attempt === maxRetries;

      if (isMVCCConflict && !isLastAttempt) {
        console.warn(
          `MVCC conflict detected, retrying... (attempt ${attempt}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt)); // Exponential backoff
        continue;
      }
      throw error; // Re-throw if not MVCC or if last attempt
    }
  }
}

// Middleware
app.use(
  cors({
    origin: "*", // For testing, allow all. For production, use your specific ngrok URL
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "ngrok-skip-browser-warning",
    ],
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

// Trust proxy for getting real IP addresses
app.set("trust proxy", true);

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Access denied. No token provided.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if session exists and is valid
    const session = await prisma.userSession.findUnique({
      where: { sessionToken: token },
      include: {
        user: {
          include: {
            farmerProfile: true,
            processorProfile: true,
            distributorProfile: true,
            retailerProfile: true,
            regulatorProfile: true,
            adminProfile: true,
          },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: "Session expired",
      });
    }

    req.user = session.user;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: "Invalid token",
    });
  }
};

// Configure multer for image uploads

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "public", "uploads", "profiles");

    // ✅ Correct: mkdir with recursive true and callback
    fs.mkdir(uploadPath, { recursive: true }, (err) => {
      if (err) return cb(err);
      cb(null, uploadPath);
    });
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});
const createEmailTransporter = () => {
  // Option A: Gmail (easiest for development)
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }

  // Option B: Outlook/Hotmail
  if (process.env.OUTLOOK_USER && process.env.OUTLOOK_PASSWORD) {
    return nodemailer.createTransport({
      service: "outlook",
      auth: {
        user: process.env.OUTLOOK_USER,
        pass: process.env.OUTLOOK_PASSWORD,
      },
    });
  }

  // Option C: Generic SMTP
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  // Option D: Development mode - log to console instead
  console.warn(
    "⚠️  No email configuration found. Emails will be logged to console."
  );
  return nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });
};

// 4. Create email sending function
const sendPasswordResetEmail = async (email, resetToken) => {
  const transporter = createEmailTransporter();
  const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";
  const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;

  // Beautiful email template
  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            .container { max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif; }
            .header { background: linear-gradient(135deg, #10B981, #059669); padding: 40px 20px; text-align: center; }
            .logo { color: white; font-size: 24px; font-weight: bold; }
            .content { padding: 40px 20px; background: #f9f9f9; }
            .button { 
                display: inline-block; 
                background: #10B981; 
                color: white; 
                padding: 15px 30px; 
                text-decoration: none; 
                border-radius: 8px; 
                font-weight: bold;
                margin: 20px 0;
            }
            .footer { padding: 20px; text-align: center; color: #666; font-size: 12px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">🌱 Plancana Agricultural System</div>
            </div>
            <div class="content">
                <h2>Password Reset Request</h2>
                <p>Hello,</p>
                <p>You requested a password reset for your Plancana account. Click the button below to reset your password:</p>
                <p style="text-align: center;">
                    <a href="${resetLink}" class="button">Reset My Password</a>
                </p>
                <p>This link will expire in 1 hour for security reasons.</p>
                <p>If you didn't request this reset, please ignore this email.</p>
                <p>Best regards,<br>The Plancana Team</p>
            </div>
            <div class="footer">
                <p>© 2025 Plancana Agricultural Supply Chain System</p>
                <p>This is an automated message, please do not reply.</p>
            </div>
        </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: process.env.FROM_EMAIL || "noreply@plancana.com",
    to: email,
    subject: "🔐 Password Reset Request - Plancana",
    html: emailHTML,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Password reset email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("❌ Email sending failed:", error);
    return { success: false, error: error.message };
  }
};
// Role-based authorization
const authorize = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "Access denied. Insufficient permissions.",
      });
    }

    next();
  };
};

// Blockchain connection helper (UNCHANGED - preserves your date handling)
class BlockchainService {
  constructor() {
    this.walletPath = path.join(
      process.cwd(),
      process.env.WALLET_PATH || "wallet"
    );
    this.connectionProfilePath = path.join(
      process.cwd(),
      process.env.CONNECTION_PROFILE_PATH || "./config/connection-profile.json"
    );
  }

  async connectToNetwork() {
    try {
      // Create wallet if it doesn't exist
      const wallet = await Wallets.newFileSystemWallet(this.walletPath);

      // Check if user exists in wallet
      const identity = await wallet.get("appUser");
      if (!identity) {
        console.log(
          "User identity does not exist in wallet. Please enroll user first."
        );
        return null;
      }

      // Load connection profile
      const connectionProfile = JSON.parse(
        fs.readFileSync(this.connectionProfilePath, "utf8")
      );

      // Create gateway
      const gateway = new Gateway();
      await gateway.connect(connectionProfile, {
        wallet,
        identity: "appUser",
        discovery: { enabled: true, asLocalhost: false },
      });

      // Get network and contract
      const network = await gateway.getNetwork("mychannel");
      const contract = network.getContract("agricultural-contract");

      return { gateway, contract };
    } catch (error) {
      console.error(`Failed to connect to network: ${error}`);
      return null;
    }
  }

  async generateBatchId() {
    return `BATCH${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  }

  async generateQRCode(batchId) {
    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";
    try {
      // Generate direct URL for easy phone scanning
      const verificationUrl = `${FRONTEND_URL}/verify/${batchId}`;

      const qrCodeData = await QRCode.toDataURL(verificationUrl, {
        errorCorrectionLevel: "M",
        type: "image/png",
        quality: 0.92,
        margin: 1,
        width: 256,
      });

      return qrCodeData;
    } catch (error) {
      console.error("QR code generation failed:", error);
      throw error;
    }
  }

  async generateProcessingQRCode(batchId) {
    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";
    try {
      // Generate direct URL for easy phone scanning
      const processingUrl = `${FRONTEND_URL}/process-batch/${batchId}`;

      const qrCodeData = await QRCode.toDataURL(processingUrl, {
        errorCorrectionLevel: "M",
        type: "image/png",
        quality: 0.92,
        margin: 1,
        width: 256,
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      });

      return qrCodeData;
    } catch (error) {
      console.error("Processing QR code generation failed:", error);
      throw error;
    }
  }

  async submitTransactionWithRetry(contract, functionName, args, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        console.log(`Attempt ${i + 1} to submit transaction: ${functionName}`);
        const result = await contract.submitTransaction(functionName, ...args);
        return result;
      } catch (error) {
        console.error(`Transaction attempt ${i + 1} failed:`, error.message);
        if (i === retries - 1) throw error;

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

const blockchainService = new BlockchainService();

// PRESERVE YOUR DATE FORMATTING FUNCTIONS (UNCHANGED)
function formatBlockchainDates(data) {
  if (Array.isArray(data)) {
    return data.map((item) => formatBlockchainDates(item));
  }

  if (typeof data === "object" && data !== null) {
    const formatted = { ...data };

    // Fix common date fields
    const dateFields = ["createdDate", "lastUpdated", "timestamp"];

    dateFields.forEach((field) => {
      if (formatted[field]) {
        // If it's a nanosecond timestamp (has decimal point)
        if (
          typeof formatted[field] === "string" &&
          formatted[field].includes(".")
        ) {
          const seconds = parseFloat(formatted[field]);
          formatted[field] = new Date(seconds * 1000).toISOString();
        }
      }
    });

    // Fix statusHistory dates
    if (formatted.statusHistory && Array.isArray(formatted.statusHistory)) {
      formatted.statusHistory = formatted.statusHistory.map((history) => ({
        ...history,
        timestamp:
          history.timestamp && history.timestamp.includes(".")
            ? new Date(parseFloat(history.timestamp) * 1000).toISOString()
            : history.timestamp,
      }));
    }

    return formatted;
  }

  return data;
}
function calculateStableHash(batch) {
  // Create a stable version by excluding changing fields
  const stableData = {
    batchId: batch.batchId,
    farmerId: batch.farmerId,
    productType: batch.productType,
    variety: batch.variety,
    quantity: batch.quantity,
    unit: batch.unit,
    harvestDate: batch.harvestDate,
    cultivationMethod: batch.cultivationMethod,
    seedsSource: batch.seedsSource,
    irrigationMethod: batch.irrigationMethod,
    fertilizers: batch.fertilizers,
    pesticides: batch.pesticides,
    qualityGrade: batch.qualityGrade,
    moistureContent: batch.moistureContent,
    proteinContent: batch.proteinContent,
    images: batch.images,
    notes: batch.notes,
    status: batch.status,
    // Exclude: id, createdAt, updatedAt, blockchainHash, dataHash, qrCodeHash
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableData))
    .digest("hex");
}

function formatVerificationData(verification) {
  // Fix timestamp formats
  const formatted = { ...verification };

  // Format main dates
  if (formatted.createdDate && formatted.createdDate.includes(".")) {
    formatted.createdDate = new Date(
      parseFloat(formatted.createdDate) * 1000
    ).toISOString();
    formatted.createdDateFormatted = new Date(
      parseFloat(verification.createdDate) * 1000
    ).toLocaleString();
  }

  if (formatted.lastUpdated && formatted.lastUpdated.includes(".")) {
    formatted.lastUpdated = new Date(
      parseFloat(formatted.lastUpdated) * 1000
    ).toISOString();
    formatted.lastUpdatedFormatted = new Date(
      parseFloat(verification.lastUpdated) * 1000
    ).toLocaleString();
  }

  // Format status history
  if (formatted.statusHistory && Array.isArray(formatted.statusHistory)) {
    formatted.statusHistory = formatted.statusHistory.map((history) => ({
      ...history,
      timestamp:
        history.timestamp && history.timestamp.includes(".")
          ? new Date(parseFloat(history.timestamp) * 1000).toISOString()
          : history.timestamp,
      timestampFormatted:
        history.timestamp && history.timestamp.includes(".")
          ? new Date(parseFloat(history.timestamp) * 1000).toLocaleString()
          : new Date(history.timestamp).toLocaleString(),
    }));
  }

  // Add verification summary
  formatted.verificationSummary = {
    batchExists: true,
    farmer: formatted.farmer,
    crop: formatted.crop,
    quantity: `${formatted.quantity} kg`,
    location: formatted.location,
    currentStatus: formatted.status || "created",
    ageInDays: formatted.createdDate
      ? Math.floor(
          (Date.now() - new Date(formatted.createdDate).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0,
    totalStatusChanges: formatted.statusHistory
      ? formatted.statusHistory.length
      : 0,
  };

  return formatted;
}

// AUTHENTICATION ROUTES
// Register new user
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, username, password, role, profileData } = req.body;

    // Validate required fields
    if (!email || !username || !password || !role) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: email, username, password, role",
      });
    }

    // Check if user exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }],
      },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: "User already exists",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(
      password,
      parseInt(process.env.BCRYPT_ROUNDS || 12)
    );

    // Create user with profile
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        role,
        status: "ACTIVE", // Auto-activate for demo
        isEmailVerified: true, // Auto-verify for demo

        // Create role-specific profile
        ...(role === "FARMER" && {
          farmerProfile: {
            create: {
              firstName: profileData?.firstName || "Farmer",
              lastName: profileData?.lastName || "User",
              farmName: profileData?.farmName || "My Farm",
              phone: profileData?.phone || "",
              address: profileData?.address || "",
              farmSize: profileData?.farmSize || 0,
              primaryCrops: profileData?.primaryCrops || [],
              farmingType: profileData?.farmingType || [],
            },
          },
        }),

        ...(role === "PROCESSOR" && {
          processorProfile: {
            create: {
              companyName: profileData?.companyName || "Processing Company",
              contactPerson: profileData?.contactPerson || username,
              phone: profileData?.phone || "",
              facilityType: profileData?.facilityType || [],
              processingCapacity: profileData?.processingCapacity || 0,
              certifications: profileData?.certifications || [],
            },
          },
        }),

        ...(role === "ADMIN" && {
          adminProfile: {
            create: {
              firstName: profileData?.firstName || "Admin",
              lastName: profileData?.lastName || "User",
              phone: profileData?.phone || "",
              adminLevel: "ADMIN",
              permissions: ["user_management", "system_config"],
            },
          },
        }),
      },
    });

    res.status(201).json({
      success: true,
      message: "Registration successful",
      userId: user.id,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      error: "Registration failed",
      details: error.message,
    });
  }
});

// Login user
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip;
    const userAgent = req.get("User-Agent");

    // Find user with profile
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        farmerProfile: true,
        processorProfile: true,
        distributorProfile: true,
        retailerProfile: true,
        regulatorProfile: true,
        adminProfile: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }

    // Check if account is active
    if (user.status !== "ACTIVE") {
      return res.status(401).json({
        success: false,
        error: "Account is not active",
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET || "your-default-secret",
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    // Create session
    const session = await prisma.userSession.create({
      data: {
        userId: user.id,
        sessionToken: token,
        ipAddress,
        userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: "LOGIN",
        ipAddress,
        userAgent,
        metadata: { sessionId: session.id },
      },
    });

    // Remove sensitive data
    const { password: _, ...userWithoutPassword } = user;

    res.json({
      success: true,
      user: userWithoutPassword,
      token,
      sessionId: session.id,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: "Login failed",
    });
  }
});
// Request password reset
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
      });
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      // Don't reveal if user exists or not for security
      return res.json({
        success: true,
        message:
          "If an account with that email exists, we have sent a password reset link.",
      });
    }

    // Generate secure reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    // Update user with reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires: resetTokenExpiry,
      },
    });

    // Send email (NEW PART!)
    const emailResult = await sendPasswordResetEmail(user.email, resetToken);

    if (emailResult.success) {
      console.log(`✅ Password reset email sent to ${email}`);
    } else {
      console.error(`❌ Failed to send email to ${email}:`, emailResult.error);
    }

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: "PASSWORD_RESET_REQUEST",
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        metadata: {
          email,
          emailSent: emailResult.success,
          messageId: emailResult.messageId,
        },
      },
    });

    // Always return success (security - don't reveal if user exists)
    res.json({
      success: true,
      message:
        "If an account with that email exists, we have sent a password reset link.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// 2. ✅ MUST HAVE - Verify token is valid
app.get("/api/auth/verify-reset-token/:token", async (req, res) => {
  try {
    const { token } = req.params;

    console.log("🔍 TOKEN DEBUG: Received token:", token);
    console.log("🔍 TOKEN DEBUG: Token length:", token.length);
    console.log("🔍 TOKEN DEBUG: Current time:", new Date().toISOString());

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });

    console.log("🔍 TOKEN DEBUG: User found with token:", !!user);
    if (user) {
      console.log("🔍 TOKEN DEBUG: User email:", user.email);
      console.log(
        "🔍 TOKEN DEBUG: Token expires at:",
        user.resetPasswordExpires
      );
      console.log("🔍 TOKEN DEBUG: Current time:", new Date().toISOString());
      console.log(
        "🔍 TOKEN DEBUG: Is expired?",
        new Date() > user.resetPasswordExpires
      );
      console.log(
        "🔍 TOKEN DEBUG: Time remaining (minutes):",
        Math.floor((user.resetPasswordExpires - new Date()) / 1000 / 60)
      );
    }

    // ⭐ THE KEY ISSUE: Make sure response matches what frontend expects
    const response = {
      success: true,
      tokenFound: !!user, // Frontend expects this field
      user: user
        ? {
            email: user.email,
            expiresAt: user.resetPasswordExpires,
          }
        : null,
      message: user ? `Reset token is valid` : "Token not found or expired",
    };

    console.log(
      "✅ TOKEN DEBUG: Sending response:",
      JSON.stringify(response, null, 2)
    );

    res.json(response);
  } catch (error) {
    console.error("❌ TOKEN DEBUG: Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      tokenFound: false,
    });
  }
});

// 3. ✅ MUST HAVE - Update password
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    // Validation
    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        error: "Token, new password, and confirm password are required",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: "Passwords do not match",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters long",
      });
    }

    // Find user with valid reset token
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired reset token",
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(
      newPassword,
      parseInt(process.env.BCRYPT_ROUNDS || 12)
    );

    // Update user password and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    // Invalidate all existing sessions for security
    await prisma.userSession.deleteMany({
      where: { userId: user.id },
    });

    console.log(`✅ Password successfully reset for user: ${user.email}`);

    res.json({
      success: true,
      message:
        "Password has been reset successfully. Please log in with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});
app.post("/api/test-email-simple", async (req, res) => {
  const nodemailer = require("nodemailer");

  try {
    console.log("🧪 Testing email with config:");
    console.log("Gmail User:", process.env.GMAIL_USER);
    console.log("Gmail Pass (length):", process.env.GMAIL_APP_PASSWORD?.length);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    // Test the connection
    await transporter.verify();
    console.log("✅ SMTP connection verified");

    // Send test email
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: req.body.email || process.env.GMAIL_USER, // Send to yourself for testing
      subject: "🧪 Test Email from Plancana",
      text: "This is a test email. If you receive this, email is working!",
      html: "<h2>✅ Email Working!</h2><p>This is a test email from your Plancana app.</p>",
    });

    console.log("✅ Test email sent:", info.messageId);
    res.json({
      success: true,
      message: "Test email sent successfully",
      messageId: info.messageId,
    });
  } catch (error) {
    console.error("❌ Email test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
app.get("/api/debug/reset-tokens", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        resetPasswordToken: { not: null },
      },
      select: {
        id: true,
        email: true,
        resetPasswordToken: true,
        resetPasswordExpires: true,
      },
    });

    res.json({
      success: true,
      count: users.length,
      tokens: users.map((user) => ({
        email: user.email,
        tokenExists: !!user.resetPasswordToken,
        tokenLength: user.resetPasswordToken?.length,
        expiresAt: user.resetPasswordExpires,
        isExpired: user.resetPasswordExpires
          ? new Date() > user.resetPasswordExpires
          : null,
        timeUntilExpiry: user.resetPasswordExpires
          ? Math.round((user.resetPasswordExpires - new Date()) / 1000 / 60) +
            " minutes"
          : null,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current user profile
app.get("/api/auth/profile", authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        farmerProfile: {
          include: {
            farmLocations: true,
            batches: {
              take: 5,
              orderBy: { createdAt: "desc" },
            },
          },
        },
        processorProfile: true,
        distributorProfile: true,
        retailerProfile: true,
        regulatorProfile: true,
        adminProfile: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Remove sensitive data
    const { password, ...userProfile } = user;

    console.log(
      "Profile data being sent:",
      JSON.stringify(userProfile, null, 2)
    ); // Debug log

    res.json({
      success: true,
      user: userProfile,
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch profile",
    });
  }
});

// MAIN ROUTES (ENHANCED WITH DATABASE INTEGRATION)

// Health check (ENHANCED)
app.get("/", async (req, res) => {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    const dbStatus = "connected";

    // Test blockchain connection
    const { gateway, contract } = await blockchainService.connectToNetwork();
    const blockchainStatus = contract ? "connected" : "disconnected";
    if (gateway) await gateway.disconnect();

    res.json({
      message: "Agricultural Supply Chain API with Database Integration",
      status: "running",
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        blockchain: blockchainStatus,
      },
      endpoints: {
        "POST /api/auth/register": "Register new user",
        "POST /api/auth/login": "Login user",
        "GET /api/auth/profile": "Get user profile",
        "POST /api/batch/create": "Create new crop batch",
        "GET /api/batch/:batchId": "Get batch details",
        "GET /api/verify/:batchId": "Verify batch (QR scan)",
        "GET /api/batches": "Get all batches",
        "GET /api/qr/:batchId": "Get QR code for batch",
        "GET /api/farmer/my-batches": "Get current farmer batches",
        "GET /api/batch/check/:batchId": "Check if batch ID exists",
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Agricultural Supply Chain API",
      status: "error",
      error: error.message,
    });
  }
});

// Create new crop batch (ENHANCED WITH DATABASE)
app.post(
  "/api/batch/create",
  authenticate,
  authorize(["FARMER"]),
  async (req, res) => {
    try {
      const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";
      const {
        farmer,
        cropType,
        crop,
        quantity,
        location,
        customBatchId,
        latitude,
        longitude,
        ...additionalData
      } = req.body;

      // DEBUG: Log received data
      console.log("📥 Received batch creation request:");
      console.log("   Basic fields:", {
        farmer,
        cropType,
        crop,
        quantity,
        location,
      });
      console.log(
        "   Additional data:",
        JSON.stringify(additionalData, null, 2)
      );
      console.log("   Pricing fields:", {
        pricePerUnit: additionalData.pricePerUnit,
        currency: additionalData.currency,
        totalBatchValue: additionalData.totalBatchValue,
        paymentMethod: additionalData.paymentMethod,
        buyerName: additionalData.buyerName,
      });

      // Validate required fields
      if (!farmer || !crop || !quantity || !location) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: farmer, crop, quantity, location",
        });
      }

      // Get farmer profile
      const farmerProfile = await prisma.farmerProfile.findUnique({
        where: { userId: req.user.id },
        include: { farmLocations: true },
      });

      if (!farmerProfile) {
        return res.status(400).json({
          success: false,
          error: "Farmer profile not found",
        });
      }

      // Generate batch ID
      const batchId =
        customBatchId || (await blockchainService.generateBatchId());

      // Connect to blockchain
      const { gateway, contract } = await blockchainService.connectToNetwork();
      if (!contract) {
        return res.status(500).json({
          success: false,
          error: "Failed to connect to blockchain network",
        });
      }

      try {
        // STEP 1: Create detailed record in database
        const batch = await prisma.batch.create({
          data: {
            batchId: batchId,
            farmerId: farmerProfile.id,
            farmLocationId: farmerProfile.farmLocations[0]?.id, // Use first farm location
            cropType: cropType || null,
            productType: crop,
            variety: additionalData.variety || null,
            quantity: parseFloat(quantity),
            unit: additionalData.unit || "kg",
            harvestDate: additionalData.harvestDate
              ? new Date(additionalData.harvestDate)
              : new Date(),
            cultivationMethod: additionalData.cultivationMethod || null,
            seedsSource: additionalData.seedsSource || null,
            irrigationMethod: additionalData.irrigationMethod || null,
            fertilizers: additionalData.fertilizers || [],
            pesticides: additionalData.pesticides || [],
            qualityGrade: additionalData.qualityGrade || null,
            moistureContent: additionalData.moistureContent
              ? parseFloat(additionalData.moistureContent)
              : null,
            proteinContent: additionalData.proteinContent
              ? parseFloat(additionalData.proteinContent)
              : null,
            images: additionalData.images || [],
            notes: additionalData.notes || null,
            // Pricing Information
            pricePerUnit: additionalData.pricePerUnit
              ? parseFloat(additionalData.pricePerUnit)
              : null,
            currency: additionalData.currency || "MYR",
            totalBatchValue: additionalData.totalBatchValue
              ? parseFloat(additionalData.totalBatchValue)
              : null,
            paymentMethod: additionalData.paymentMethod || null,
            buyerName: additionalData.buyerName || null,
            // Certifications & Compliance
            certifications: additionalData.certifications || [],
            customCertification: additionalData.customCertification || null,
            myGapCertNumber: additionalData.myGapCertNumber || null, // Database only
            status: "REGISTERED",
          },
          include: {
            farmer: {
              include: {
                user: {
                  select: { username: true, email: true },
                },
              },
            },
            farmLocation: true,
          },
        });

        // STEP 2: Create hash of database data for integrity
        const dataHash = calculateStableHash(batch);

        // STEP 2.5: 🤖 ML VALIDATION - Fraud Detection
        let mlValidation = null;
        try {
          mlValidation = await validateBatchWithML({
            batchId: batchId,
            crop: crop,
            productType: crop,
            quantity: parseFloat(quantity),
            pricePerUnit: additionalData.pricePerUnit
              ? parseFloat(additionalData.pricePerUnit)
              : 0,
            latitude: parseFloat(latitude) || 0,
            longitude: parseFloat(longitude) || 0,
            temperature: batch.farmLocation?.temperature || 28,
            humidity: batch.farmLocation?.humidity || 75,
            moistureContent: additionalData.moistureContent
              ? parseFloat(additionalData.moistureContent)
              : 12,
            qualityGrade: additionalData.qualityGrade || "B",
            weather_main: batch.farmLocation?.weather_main || "Clear",
          });

          // Log ML validation to notes field for transparency
          if (mlValidation) {
            const mlNote =
              `\n\n🤖 ML Fraud Detection:\n` +
              `- Risk Level: ${mlValidation.riskLevel}\n` +
              `- Anomaly Score: ${(mlValidation.anomalyScore * 100).toFixed(
                1
              )}%\n` +
              `- Status: ${
                mlValidation.isAnomaly ? "⚠️  FLAGGED FOR REVIEW" : "✅ PASSED"
              }\n` +
              `- Recommendation: ${mlValidation.recommendation}` +
              (mlValidation.flags && mlValidation.flags.length > 0
                ? `\n- Flags: ${mlValidation.flags
                    .map((f) => f.type)
                    .join(", ")}`
                : "");

            // Update batch notes with ML validation
            await prisma.batch.update({
              where: { id: batch.id },
              data: {
                notes: (batch.notes || "") + mlNote,
              },
            });
          }
        } catch (mlError) {
          console.error(
            "⚠️  ML validation failed, continuing without it:",
            mlError.message
          );
        }

        // STEP 3: Submit critical data to blockchain with pricing and certifications
        const blockchainData = {
          cropType: cropType,
          variety: additionalData.variety,
          unit: additionalData.unit || "kg",
          harvestDate: additionalData.harvestDate,
          cultivationMethod: additionalData.cultivationMethod,
          qualityGrade: additionalData.qualityGrade,
          certifications: additionalData.certifications || [],
          customCertification: additionalData.customCertification,
          // Pricing Information
          pricePerUnit: additionalData.pricePerUnit,
          currency: additionalData.currency || "MYR",
          totalBatchValue: additionalData.totalBatchValue,
          paymentMethod: additionalData.paymentMethod,
          buyerName: additionalData.buyerName,
          // Coordinates if available
          coordinates:
            additionalData.latitude && additionalData.longitude
              ? {
                  latitude: parseFloat(additionalData.latitude),
                  longitude: parseFloat(additionalData.longitude),
                }
              : null,
          // 🤖 ML Fraud Detection Results
          mlValidation: mlValidation
            ? {
                verified: !mlValidation.isAnomaly,
                anomalyScore: mlValidation.anomalyScore,
                riskLevel: mlValidation.riskLevel,
                flags: mlValidation.flags || [],
                timestamp: new Date().toISOString(),
              }
            : null,
        };

        const result = await blockchainService.submitTransactionWithRetry(
          contract,
          "createBatch",
          [
            batchId,
            farmer,
            crop,
            quantity.toString(),
            location,
            JSON.stringify(blockchainData),
          ]
        );

        // STEP 4: Update database with blockchain reference
        const updatedBatch = await prisma.batch.update({
          where: { id: batch.id },
          data: {
            blockchainHash: result.toString(),
            dataHash: dataHash,
            qrCodeHash: crypto
              .createHash("sha256")
              .update(`${batchId}_${Date.now()}`)
              .digest("hex"),
          },
        });

        // STEP 5: Generate BOTH QR codes (verification + processing)
        const verificationQR = await blockchainService.generateQRCode(batchId);
        const processingQR = await blockchainService.generateProcessingQRCode(
          batchId
        );

        await gateway.disconnect();
        // STEP 6: Execute PostGIS logic to update FarmLocation
        // 1. Get the Farmer's active Farm Location (or the one being used)
        let locationIdToUse = null;
        if (latitude && longitude) {
          const newLocationRecord = await prisma.farmLocation.create({
            data: {
              farmerId: farmerProfile.id,
              location: location || "Default Farm Location",
              latitude: parseFloat(latitude),
              longitude: parseFloat(longitude),
              temperature: additionalData.temperature
                ? parseFloat(additionalData.temperature)
                : null,
              humidity: additionalData.humidity
                ? parseFloat(additionalData.humidity)
                : null,
              weather_main: additionalData.weather_main || null,
              weather_desc: additionalData.weather_description || null,
              farmName: farmerProfile.farmName,
            },
          });

          locationIdToUse = newLocationRecord.id;

          // Update PostGIS geometry
          await updateGeometryPoint(
            '"farm_locations"',
            newLocationRecord.id,
            newLocationRecord.latitude,
            newLocationRecord.longitude
          );
        }
        if (locationIdToUse) {
          await prisma.batch.update({
            where: { id: batch.id },
            data: { farmLocationId: locationIdToUse },
          });
        }

        if (latitude && longitude && batch.id) {
          await logBatchLocation(
            batch.id,
            batch.status,
            parseFloat(latitude),
            parseFloat(longitude),
            {
              location: location,
              source: "Farmer Input",
              productName: crop,
              quality: additionalData.qualityGrade,
              cropType: cropType,
              quantity: quantity,
              temperature: additionalData.temperature
                ? parseFloat(additionalData.temperature)
                : null,
              humidity: additionalData.humidity
                ? parseFloat(additionalData.humidity)
                : null,
              weather_main: additionalData.weather_main || null,
              weather_desc: additionalData.weather_description || null,
            }
          );
        } else {
          console.log("try again");
        }
        // STEP: Log activity
        await prisma.activityLog.create({
          data: {
            userId: req.user.id,
            action: "CREATE_BATCH",
            resource: batchId,
            ipAddress: req.ip,
            userAgent: req.get("User-Agent"),
            metadata: { batchId: batchId },
          },
        });

        const response = {
          success: true,
          batchId: batchId,
          batchData: JSON.parse(result.toString()),
          databaseRecord: updatedBatch,
          qrCodes: {
            verification: verificationQR,
            processing: processingQR,
          },
          // Keep backward compatibility with old 'qrCode' field
          qrCode: verificationQR,
          verificationUrl: `${FRONTEND_URL}/verify/${batchId}`,
          processingUrl: `${FRONTEND_URL}/process-batch/${batchId}`,
          message:
            "Crop batch created successfully on blockchain and database with both QR codes",
          dataIntegrity: {
            blockchainHash: result.toString(),
            databaseHash: dataHash,
          },
          // 🤖 ML Fraud Detection Results
          mlValidation: mlValidation
            ? {
                isAnomaly: mlValidation.isAnomaly,
                anomalyScore: mlValidation.anomalyScore,
                riskLevel: mlValidation.riskLevel,
                recommendation: mlValidation.recommendation,
                flags: mlValidation.flags || [],
                message: mlValidation.isAnomaly
                  ? "⚠️  Batch flagged by ML system for review"
                  : "✅  Batch verified by ML fraud detection",
              }
            : {
                message: "ℹ️  ML validation not available",
              },
        };

        console.log(`Successfully created batch: ${batchId}`);
        res.status(201).json(response);
      } catch (blockchainError) {
        await gateway.disconnect();
        console.error("Blockchain transaction failed:", blockchainError);

        res.status(500).json({
          success: false,
          error: "Failed to create batch on blockchain",
          details: blockchainError.message,
        });
      }
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
        details: error.message,
      });
    }
  }
);

// Get farmer's batches (ENHANCED)
app.get(
  "/api/farmer/my-batches",
  authenticate,
  authorize(["FARMER"]),
  async (req, res) => {
    try {
      const farmerProfile = await prisma.farmerProfile.findUnique({
        where: { userId: req.user.id },
      });

      if (!farmerProfile) {
        return res.status(400).json({
          success: false,
          error: "Farmer profile not found",
        });
      }

      // Get batches from database
      const batches = await prisma.batch.findMany({
        where: { farmerId: farmerProfile.id },
        include: {
          farmLocation: true,
          processingRecords: {
            include: {
              processor: {
                include: {
                  user: { select: { username: true } },
                },
              },
            },
          },
          _count: {
            select: {
              processingRecords: true,
              transportRoutes: true,
              qualityTests: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Also get blockchain data for comparison
      const { gateway, contract } = await blockchainService.connectToNetwork();
      let blockchainBatches = [];

      if (contract) {
        try {
          const result = await contract.evaluateTransaction("getAllBatches");
          const allBlockchainBatches = JSON.parse(result.toString());
          blockchainBatches = allBlockchainBatches.filter(
            (batch) =>
              batch.farmer.toLowerCase() === req.user.username.toLowerCase()
          );
          await gateway.disconnect();
        } catch (blockchainError) {
          await gateway.disconnect();
          console.error("Blockchain query failed:", blockchainError);
        }
      }

      res.json({
        success: true,
        farmer: req.user.username,
        farmerProfile: {
          farmName: farmerProfile.farmName,
          totalBatches: batches.length,
        },
        count: batches.length,
        batches: batches,
        blockchainBatches: formatBlockchainDates(blockchainBatches),
        dataIntegrity: {
          databaseCount: batches.length,
          blockchainCount: blockchainBatches.length,
          syncStatus:
            batches.length === blockchainBatches.length
              ? "SYNCED"
              : "OUT_OF_SYNC",
        },
      });
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  }
);

// Validate batch processing access (for mobile QR scanning)
app.get(
  "/api/batch/validate-access/:batchId",
  authenticate,
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const user = req.user;

      // Fetch batch from database
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        select: {
          id: true,
          batchId: true,
          status: true,
          farmerId: true,
          productType: true,
          quantity: true,
          farmer: {
            include: {
              user: {
                select: { username: true, email: true },
              },
            },
          },
        },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          canProcess: false,
          reason: "Batch not found",
          error: `Batch ${batchId} does not exist`,
        });
      }

      // Define access matrix based on role and batch status
      const ACCESS_MATRIX = {
        PROCESSOR: {
          REGISTERED: {
            canProcess: true,
            action: "PROCESS",
            redirectTo: `/processor/process/${batchId}`,
            message: "You can start processing this batch",
          },
        },
        DISTRIBUTOR: {
          PROCESSED: {
            canProcess: true,
            action: "RECEIVE",
            redirectTo: `/distributor/receive/${batchId}`,
            message: "You can receive this batch from processor",
          },
          IN_DISTRIBUTION: {
            canProcess: true,
            action: "DISTRIBUTE",
            redirectTo: `/distributor/distribute/${batchId}`,
            message: "You can add distribution records for this batch",
          },
        },
        RETAILER: {
          RETAIL_READY: {
            canProcess: true,
            action: "RETAIL",
            redirectTo: `/retailer/receive/${batchId}`,
            message: "You can receive this batch for retail",
          },
          IN_RETAIL: {
            canProcess: true,
            action: "SET_PRICE",
            redirectTo: `/retailer/price/${batchId}`,
            message: "You can set retail pricing for this batch",
          },
        },
      };

      // Check if user role has access to this batch status
      const roleAccess = ACCESS_MATRIX[user.role];

      if (!roleAccess) {
        return res.status(403).json({
          success: false,
          canProcess: false,
          reason: "Invalid role",
          error: `Role ${user.role} cannot process batches`,
        });
      }

      const statusAccess = roleAccess[batch.status];

      if (!statusAccess) {
        // Find what status this role CAN process
        const validStatuses = Object.keys(roleAccess);

        return res.status(403).json({
          success: false,
          canProcess: false,
          reason: "Invalid batch status for your role",
          error: `As a ${
            user.role
          }, you can only process batches with status: ${validStatuses.join(
            ", "
          )}. This batch has status: ${batch.status}`,
          currentStatus: batch.status,
          validStatuses: validStatuses,
          batchInfo: {
            batchId: batch.batchId,
            product: batch.productType,
            farmer: batch.farmer.user.username,
          },
        });
      }

      // User has access!
      return res.json({
        success: true,
        canProcess: true,
        action: statusAccess.action,
        redirectTo: statusAccess.redirectTo,
        message: statusAccess.message,
        batchInfo: {
          batchId: batch.batchId,
          status: batch.status,
          product: batch.productType,
          quantity: batch.quantity,
          farmer: batch.farmer.user.username,
        },
      });
    } catch (error) {
      console.error("Error validating batch access:", error);
      res.status(500).json({
        success: false,
        canProcess: false,
        reason: "Server error",
        error: "Failed to validate batch access",
      });
    }
  }
);

// Get specific batch details (ENHANCED)
app.get("/api/batch/:batchId", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Get from database
    const dbBatch = await prisma.batch.findUnique({
      where: { batchId: batchId },
      include: {
        farmer: {
          include: {
            user: {
              select: { username: true, email: true, role: true },
            },
          },
        },
        farmLocation: true,
        processingRecords: {
          include: {
            processor: {
              include: {
                user: { select: { username: true } },
              },
            },
            facility: true,
          },
        },
        transportRoutes: true,
        qualityTests: true,
        transactions: true,
        parentBatch: {
          select: { batchId: true, id: true },
        },
      },
    });

    const distributorIds = dbBatch.transportRoutes.map(
      (route) => route.distributorId
    );
    const distributors = await prisma.distributorProfile.findMany({
      where: { id: { in: distributorIds } },
    });

    // Get distribution records (they use batchId as string, not relation)
    // For split batches: only include parent's records from BEFORE the split
    const splitDate = dbBatch?.splitDate;

    let distributionRecords = await prisma.distributionRecord.findMany({
      where: { batchId: batchId },
      orderBy: { distributionDate: "desc" },
    });

    // For split batches: get parent's distribution records from BEFORE the split
    if (dbBatch?.parentBatch?.batchId && splitDate) {
      const parentDistributionRecords =
        await prisma.distributionRecord.findMany({
          where: {
            batchId: dbBatch.parentBatch.batchId,
            distributionDate: { lt: splitDate },
          },
          orderBy: { distributionDate: "desc" },
        });
      distributionRecords = [
        ...parentDistributionRecords,
        ...distributionRecords,
      ];
    }

    // For split batches, also fetch parent batch's processing records and transport routes
    // Only records created BEFORE the split date
    let parentProcessingRecords = [];
    let parentTransportRoutes = [];
    if (dbBatch?.parentBatch?.id && splitDate) {
      parentProcessingRecords = await prisma.processingRecord.findMany({
        where: {
          batchId: dbBatch.parentBatch.id,
          processingDate: { lt: splitDate },
        },
        include: {
          processor: {
            include: {
              user: { select: { username: true } },
            },
          },
          facility: true,
        },
        orderBy: { processingDate: "asc" },
      });

      parentTransportRoutes = await prisma.transportRoute.findMany({
        where: {
          batchId: dbBatch.parentBatch.id,
          departureTime: { lt: splitDate },
        },
        orderBy: { departureTime: "asc" },
      });
    }

    // Merge parent records with current batch records (parent records first, chronologically)
    if (dbBatch && parentProcessingRecords.length > 0) {
      dbBatch.processingRecords = [
        ...parentProcessingRecords,
        ...dbBatch.processingRecords,
      ];
    }
    if (dbBatch && parentTransportRoutes.length > 0) {
      dbBatch.transportRoutes = [
        ...parentTransportRoutes,
        ...dbBatch.transportRoutes,
      ];
    }

    // Get transfer history for this batch
    const transferBatchIds = [batchId];
    if (dbBatch?.parentBatch?.batchId) {
      transferBatchIds.push(dbBatch.parentBatch.batchId);
    }

    const transfers = await prisma.batchTransfer.findMany({
      where: { batchId: { in: transferBatchIds } },
      orderBy: { transferDate: "asc" },
    });

    // Enrich transfer history with actor usernames
    const actorIds = [
      ...new Set(transfers.flatMap((t) => [t.fromActorId, t.toActorId])),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: {
        id: true,
        username: true,
        farmerProfile: {
          select: { firstName: true, lastName: true, farmName: true },
        },
        processorProfile: { select: { companyName: true } },
        distributorProfile: { select: { companyName: true } },
        retailerProfile: { select: { businessName: true } },
      },
    });

    // Build user map with display names
    const userMap = Object.fromEntries(
      users.map((u) => {
        let displayName = u.username;
        if (u.farmerProfile) {
          displayName =
            `${u.farmerProfile.firstName || ""} ${
              u.farmerProfile.lastName || ""
            }`.trim() ||
            u.farmerProfile.farmName ||
            u.username;
        } else if (u.processorProfile?.companyName) {
          displayName = u.processorProfile.companyName;
        } else if (u.distributorProfile?.companyName) {
          displayName = u.distributorProfile.companyName;
        } else if (u.retailerProfile?.businessName) {
          displayName = u.retailerProfile.businessName;
        }
        return [u.id, { username: u.username, displayName }];
      })
    );

    const transferHistory = transfers.map((t) => ({
      ...t,
      fromActorUsername: userMap[t.fromActorId]?.username || null,
      fromActorName: userMap[t.fromActorId]?.displayName || null,
      toActorUsername: userMap[t.toActorId]?.username || null,
      toActorName: userMap[t.toActorId]?.displayName || null,
    }));

    // Get from blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();
    let blockchainBatch = null;

    if (contract) {
      try {
        const result = await contract.evaluateTransaction("getBatch", batchId);
        blockchainBatch = JSON.parse(result.toString());
        await gateway.disconnect();
      } catch (blockchainError) {
        await gateway.disconnect();
        if (!blockchainError.message.includes("does not exist")) {
          console.error("Blockchain query failed:", blockchainError);
        }
      }
    }

    if (!dbBatch && !blockchainBatch) {
      return res.status(404).json({
        success: false,
        error: `Batch ${batchId} not found`,
      });
    }

    // Role-based data filtering (same as before but with database data)
    let responseData = dbBatch;

    switch (req.user.role) {
      case "FARMER":
        if (dbBatch && dbBatch.farmer.userId !== req.user.id) {
          return res.status(403).json({
            success: false,
            error: "Access denied",
          });
        }
        break;

      case "PROCESSOR":
        if (dbBatch) {
          const hasProcessed = dbBatch.processingRecords.some(
            (record) => record.processor.userId === req.user.id
          );
          if (!hasProcessed && dbBatch.farmer.userId !== req.user.id) {
            // Filter sensitive information
            responseData = {
              ...dbBatch,
              farmer: {
                user: { username: "FARMER_***" },
              },
            };
          }
        }
        break;

      case "RETAILER":
        // Retailers see limited information
        if (dbBatch) {
          responseData = {
            batchId: dbBatch.batchId,
            productType: dbBatch.productType,
            variety: dbBatch.variety,
            quantity: dbBatch.quantity,
            harvestDate: dbBatch.harvestDate,
            qualityGrade: dbBatch.qualityGrade,
            qualityTests: dbBatch.qualityTests,
            status: dbBatch.status,
            farmLocation: {
              farmName: dbBatch.farmLocation?.farmName || "Farm",
            },
          };
        }
        break;

      case "DISTRIBUTOR":
        // Distributors can access batch info for batches they can distribute
        // They see full batch info needed for distribution
        if (dbBatch) {
          responseData = {
            ...dbBatch,
            // Mask farmer personal info
            farmer: {
              ...dbBatch.farmer,
              user: {
                username: dbBatch.farmer?.user?.username || "Farmer",
                role: "FARMER"
              },
            },
          };
        }
        break;

      case "REGULATOR":
      case "ADMIN":
        // Full access
        break;

      default:
        return res.status(403).json({
          success: false,
          error: "Access denied",
        });
    }

    // Data integrity check
    let integrityStatus = "UNKNOWN";
    if (dbBatch && blockchainBatch && dbBatch.dataHash) {
      const currentHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(dbBatch))
        .digest("hex");
      integrityStatus = currentHash === dbBatch.dataHash ? "VALID" : "MODIFIED";
    }

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: req.user.id,
        action: "VIEW_BATCH",
        resource: batchId,
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
      },
    });

    res.json({
      success: true,
      batchId: batchId,
      batchData: responseData,
      distributionRecords: distributionRecords, // Location & quantity at distributor level
      transferHistory: transferHistory, // Ownership transfer history (SC-01)
      blockchain: blockchainBatch
        ? formatBlockchainDates(blockchainBatch)
        : null,
      accessLevel: req.user.role,
      dataIntegrity: {
        status: integrityStatus,
        databaseExists: !!dbBatch,
        blockchainExists: !!blockchainBatch,
        lastVerified: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Check if batch ID already exists (ENHANCED)
app.get("/api/batch/check/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    // Check in database first (faster)
    const dbBatch = await prisma.batch.findUnique({
      where: { batchId: batchId },
      select: { batchId: true, status: true, createdAt: true },
    });

    // Check in blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();
    let blockchainExists = false;

    if (contract) {
      try {
        await contract.evaluateTransaction("getBatch", batchId);
        blockchainExists = true;
        await gateway.disconnect();
      } catch (blockchainError) {
        await gateway.disconnect();
        blockchainExists = !blockchainError.message.includes("does not exist");
      }
    }

    const exists = !!dbBatch || blockchainExists;

    res.json({
      success: true,
      exists: exists,
      batchId: batchId,
      sources: {
        database: !!dbBatch,
        blockchain: blockchainExists,
      },
      message: exists
        ? `Batch ${batchId} already exists`
        : `Batch ID ${batchId} is available`,
      batchInfo: dbBatch || null,
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Verify batch (QR code endpoint) (ENHANCED)
app.get("/api/verify/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    // Get from database
    const dbBatch = await prisma.batch.findUnique({
      where: { batchId: batchId },
      include: {
        farmer: {
          include: {
            user: { select: { username: true } },
          },
        },
        farmLocation: true,
        processingRecords: {
          include: {
            processor: {
              include: {
                user: { select: { username: true } },
              },
            },
          },
        },
        qualityTests: {
          orderBy: { testDate: "desc" },
          take: 3,
        },
      },
    });

    // Get from blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();
    let blockchainVerification = null;

    if (contract) {
      try {
        const result = await contract.evaluateTransaction(
          "verifyBatch",
          batchId
        );
        blockchainVerification = JSON.parse(result.toString());
        await gateway.disconnect();
      } catch (blockchainError) {
        await gateway.disconnect();
        if (!blockchainError.message.includes("does not exist")) {
          console.error("Blockchain verification failed:", blockchainError);
        }
      }
    }

    if (!dbBatch && !blockchainVerification) {
      return res.status(404).json({
        success: false,
        verified: false,
        error: `Batch ${batchId} not found - potential fraud`,
        verificationTime: new Date().toISOString(),
      });
    }

    // Data integrity verification
    let integrityCheck = {
      valid: false,
      message: "Unable to verify integrity",
    };

    if (dbBatch && blockchainVerification && dbBatch.dataHash) {
      const currentHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(dbBatch))
        .digest("hex");

      integrityCheck = {
        valid: currentHash === dbBatch.dataHash,
        message:
          currentHash === dbBatch.dataHash
            ? "Data integrity verified"
            : "Data may have been modified",
        databaseHash: dbBatch.dataHash,
        currentHash: currentHash,
      };
    }

    // ========== FETCH BLOCKCHAIN PRICING DATA EARLY ==========
    let blockchainPricing = {};
    if (dbBatch) {
      try {
        const { gateway: pricingGateway, contract: pricingContract } =
          await blockchainService.connectToNetwork();
        const pricingResult = await pricingContract.evaluateTransaction(
          "getPricingHistory",
          batchId
        );
        const pricingData = JSON.parse(pricingResult.toString());
        await pricingGateway.disconnect();

        // Map pricing by level for easy lookup
        if (
          pricingData.pricingHistory &&
          Array.isArray(pricingData.pricingHistory)
        ) {
          pricingData.pricingHistory.forEach((priceRecord) => {
            blockchainPricing[priceRecord.level] = {
              pricePerUnit: parseFloat(priceRecord.pricePerUnit),
              totalValue: parseFloat(priceRecord.totalValue),
              currency: priceRecord.currency || "MYR",
              breakdown: priceRecord.breakdown || {},
            };
          });
          console.log(
            "💰 Blockchain Pricing Loaded:",
            Object.keys(blockchainPricing)
          );
        }
      } catch (pricingError) {
        console.log(
          "⚠️ Could not fetch blockchain pricing:",
          pricingError.message
        );
        // Continue without pricing data
      }
    }
    // ========== END FETCH BLOCKCHAIN PRICING ==========

    // Get ownership transfer history from BatchTransfer
    let ownershipHistory = [];
    console.log(
      "🔍 Starting ownership history lookup for batch:",
      dbBatch?.batchId,
      "UUID:",
      dbBatch?.id,
      "Status:",
      dbBatch?.status
    );

    if (dbBatch) {
      try {
        // Try both batchId (string) and id (UUID) to be safe
        const transfers = await prisma.batchTransfer.findMany({
          where: {
            OR: [{ batchId: dbBatch.id }, { batchId: dbBatch.batchId }],
          },
          orderBy: { transferDate: "asc" },
        });

        console.log(
          "📦 Batch Transfers Found:",
          transfers.length,
          "for batch:",
          dbBatch.batchId
        );
        if (transfers.length > 0) {
          console.log(
            "📦 Transfer Details:",
            JSON.stringify(transfers, null, 2)
          );
        }

        // Get transactions for pricing (Transaction.batchId is a foreign key to Batch.id, so use UUID only)
        const transactions = await prisma.transaction.findMany({
          where: {
            batchId: dbBatch.id, // Must use UUID, not human-readable batchId
          },
          orderBy: { id: "asc" },
        });

        console.log("💰 Transactions Found:", transactions.length);
        if (transactions.length > 0) {
          console.log(
            "💰 Transaction Details:",
            JSON.stringify(
              transactions.map((t) => ({
                id: t.id,
                fromPartyId: t.fromPartyId,
                toPartyId: t.toPartyId,
                totalAmount: t.totalAmount,
              })),
              null,
              2
            )
          );
        }

        // Helper function to get actor name
        const getActorName = async (actorId, role) => {
          try {
            if (role === "FARMER") {
              const farmer = await prisma.farmerProfile.findUnique({
                where: { id: actorId },
                select: { farmName: true },
              });
              return farmer?.farmName || "Farmer";
            } else if (role === "PROCESSOR") {
              const processor = await prisma.processorProfile.findUnique({
                where: { id: actorId },
                select: { facilityName: true },
              });
              return processor?.facilityName || "Processor";
            } else if (role === "DISTRIBUTOR") {
              const distributor = await prisma.distributorProfile.findUnique({
                where: { id: actorId },
                select: { companyName: true },
              });
              return distributor?.companyName || "Distributor";
            } else if (role === "RETAILER") {
              const retailer = await prisma.retailerProfile.findUnique({
                where: { id: actorId },
                select: { storeName: true },
              });
              return retailer?.storeName || "Retailer";
            }
          } catch (e) {
            console.log("Error getting actor name:", e.message);
          }
          return "Unknown";
        };

        // Build ownership history with actor names and prices
        ownershipHistory = await Promise.all(
          transfers.map(async (transfer) => {
            const fromName = await getActorName(
              transfer.fromActorId,
              transfer.fromActorRole
            );
            const toName = await getActorName(
              transfer.toActorId,
              transfer.toActorRole
            );

            // Find matching transaction for pricing
            const matchingTx = transactions.find(
              (tx) =>
                tx.fromPartyId === transfer.fromActorId &&
                tx.toPartyId === transfer.toActorId
            );

            // Get pricing from blockchain based on the recipient's role
            const rolePricing = blockchainPricing[transfer.toRole] || {};
            const blockchainPrice = rolePricing.pricePerUnit;

            // Prefer blockchain pricing, fall back to transaction pricing
            const pricePerUnit =
              blockchainPrice ||
              (matchingTx ? matchingTx.totalAmount / dbBatch.quantity : null);

            return {
              from: fromName,
              to: toName,
              fromRole: transfer.fromActorRole,
              toRole: transfer.toActorRole,
              transferDate: transfer.transferDate,
              timestamp: transfer.transferDate,
              location: transfer.transferLocation,
              quantity: dbBatch.quantity, // BatchTransfer doesn't have quantity, use batch quantity
              pricePerUnit: pricePerUnit,
              totalValue: pricePerUnit
                ? pricePerUnit * dbBatch.quantity
                : matchingTx?.totalAmount,
              notes: transfer.notes,
              status: transfer.status,
            };
          })
        );

        console.log(
          "📊 Ownership History Built:",
          ownershipHistory.length,
          "entries"
        );
        if (ownershipHistory.length > 0) {
          console.log(
            "📊 Ownership History Details:",
            JSON.stringify(ownershipHistory, null, 2)
          );
        }

        // If no transfer history found but batch is SOLD/DELIVERED/IN_RETAIL, create synthetic history
        if (
          ownershipHistory.length === 0 &&
          (dbBatch.status === "SOLD" ||
            dbBatch.status === "DELIVERED" ||
            dbBatch.status === "IN_RETAIL")
        ) {
          console.log(
            "⚠️ No transfer history found for",
            dbBatch.status,
            "batch, creating synthetic history"
          );

          // Create a synthetic sale record
          ownershipHistory.push({
            from: dbBatch.farmer?.farmName || "Farmer",
            to: "Customer",
            fromRole: "FARMER",
            toRole: "RETAILER",
            transferDate: dbBatch.updatedAt,
            timestamp: dbBatch.updatedAt,
            location: "Market",
            quantity: dbBatch.quantity,
            pricePerUnit: dbBatch.pricePerUnit,
            totalValue: dbBatch.pricePerUnit * dbBatch.quantity,
            notes: `Direct sale - Status: ${dbBatch.status}`,
            status: "COMPLETED",
          });

          console.log(
            "📊 Synthetic Ownership History created:",
            JSON.stringify(ownershipHistory, null, 2)
          );
        }
      } catch (err) {
        console.error("❌ BatchTransfer table error:", err);
        console.error("❌ Error stack:", err.stack);
      }
    } else {
      console.log("⚠️ dbBatch is null, cannot retrieve ownership history");
    }

    // Get batch lineage (parent/child relationships)
    let lineageInfo = null;
    if (dbBatch) {
      // Get parent batch if exists
      let parentBatch = null;
      if (dbBatch.parentBatchId) {
        parentBatch = await prisma.batch.findUnique({
          where: { id: dbBatch.parentBatchId },
          select: {
            batchId: true,
            quantity: true,
            unit: true,
            status: true,
            productType: true,
          },
        });
      }

      // Get child batches
      const childBatches = await prisma.batch.findMany({
        where: { parentBatchId: dbBatch.id },
        select: {
          batchId: true,
          quantity: true,
          unit: true,
          status: true,
          splitReason: true,
          splitDate: true,
        },
        orderBy: { createdAt: "asc" },
      });

      if (parentBatch || childBatches.length > 0) {
        lineageInfo = {
          isChild: !!dbBatch.parentBatchId,
          isParent: childBatches.length > 0,
          splitReason: dbBatch.splitReason || null,
          splitDate: dbBatch.splitDate || null,
          parent: parentBatch,
          children: childBatches,
          totalChildren: childBatches.length,
        };
      }
    }

    // Create comprehensive verification response
    const verificationResponse = {
      success: true,
      verified: true,
      batchId: batchId,
      verificationTime: new Date().toISOString(),

      // Basic batch info (public)
      batchInfo: dbBatch
        ? {
            productType: dbBatch.productType,
            quantity: dbBatch.quantity,
            unit: dbBatch.unit || "kg",
            harvestDate: dbBatch.harvestDate,
            status: dbBatch.status,
            pricePerUnit: dbBatch.pricePerUnit,
            currency: "MYR",
            farmer: {
              farmName: dbBatch.farmer?.farmName,
              user: dbBatch.farmer?.user,
              bio: dbBatch.farmer?.bio,
            },
            farmLocation: dbBatch.farmLocation,
            location:
              dbBatch.farmLocation?.location || dbBatch.farmLocation?.farmName,
            certifications: dbBatch.certifications,
            notes: dbBatch.notes,
            // Additional fields
            crop: dbBatch.productType,
            variety: dbBatch.variety,
            cropType: dbBatch.cropType,
            qualityGrade: dbBatch.qualityGrade,
            moistureContent: dbBatch.moistureContent,
            proteinContent: dbBatch.proteinContent,
          }
        : {
            productType: blockchainVerification?.crop,
            quantity: blockchainVerification?.quantity,
            harvestDate: blockchainVerification?.createdDate,
            status: blockchainVerification?.status,
            farmer: blockchainVerification?.farmer,
            location: blockchainVerification?.location,
          },

      // Verification details
      verification: {
        blockchain: blockchainVerification
          ? formatVerificationData(blockchainVerification)
          : null,
        database: {
          exists: !!dbBatch,
          recordCount: dbBatch
            ? {
                processingRecords: dbBatch.processingRecords?.length || 0,
                qualityTests: dbBatch.qualityTests?.length || 0,
              }
            : null,
        },
        dataIntegrity: integrityCheck,
      },

      // Supply chain summary with full stage details
      supplyChainSummary: dbBatch
        ? {
            totalStages: [
              "HARVEST",
              ...(dbBatch.processingRecords?.length > 0 ? ["PROCESSING"] : []),
              ...(dbBatch.status === "DELIVERED" ? ["DELIVERY"] : []),
            ],
            currentStage: dbBatch.status,

            // Processing stages with details
            processingStages:
              dbBatch.processingRecords?.map((record) => {
                // Get pricing from blockchain if available
                const processorPricing = blockchainPricing["PROCESSOR"] || {};
                return {
                  processor: record.processor?.user?.username || "Processor",
                  processorName:
                    record.processor?.facilityName || "Processing Facility",
                  facility: record.processor?.facilityName,
                  location: record.processor?.location,
                  timestamp: record.processingDate,
                  date: record.processingDate,
                  inputQuantity: record.inputQuantity,
                  outputQuantity: record.outputQuantity,
                  quantity: record.outputQuantity,
                  unit: dbBatch.unit,
                  pricePerUnit:
                    processorPricing.pricePerUnit || dbBatch.pricePerUnit,
                  currency: processorPricing.currency || "MYR",
                  notes:
                    record.notes ||
                    `Processed: ${record.inputQuantity} ${dbBatch.unit} → ${record.outputQuantity} ${dbBatch.unit}`,
                };
              }) || [],

            // Distribution/Transfer stages from ownership history (ONLY DISTRIBUTOR)
            distributionStages: (() => {
              const stages = ownershipHistory
                .filter((transfer) => transfer.toRole === "DISTRIBUTOR")
                .map((transfer, idx) => {
                  // Get pricing from blockchain based on the role
                  const rolePricing = blockchainPricing[transfer.toRole] || {};

                  return {
                    distributor: transfer.to,
                    distributorName: transfer.to,
                    warehouse: transfer.location || "Distribution Center",
                    location: transfer.location,
                    timestamp: transfer.transferDate,
                    date: transfer.transferDate,
                    quantity: transfer.quantity,
                    unit: dbBatch.unit,
                    pricePerUnit:
                      rolePricing.pricePerUnit || transfer.pricePerUnit || null,
                    currency: rolePricing.currency || "MYR",
                    notes: transfer.notes || `Transferred to ${transfer.to}`,
                  };
                });
              console.log("🚚 Distribution Stages:", stages.length, stages);
              return stages;
            })(),

            // Retail stages from ownership history (ONLY RETAILER)
            retailStages: (() => {
              const stages = ownershipHistory
                .filter((transfer) => transfer.toRole === "RETAILER")
                .map((transfer, idx) => {
                  // Get pricing from blockchain based on the role
                  const rolePricing = blockchainPricing[transfer.toRole] || {};

                  return {
                    retailer: transfer.to,
                    retailerName: transfer.to,
                    store: transfer.location || "Retail Store",
                    location: transfer.location,
                    timestamp: transfer.transferDate,
                    date: transfer.transferDate,
                    quantity: transfer.quantity,
                    unit: dbBatch.unit,
                    pricePerUnit:
                      rolePricing.pricePerUnit || transfer.pricePerUnit || null,
                    currency: rolePricing.currency || "MYR",
                    notes: transfer.notes || `Transferred to ${transfer.to}`,
                  };
                });
              console.log("🏪 Retail Stages:", stages.length, stages);
              return stages;
            })(),

            // Full ownership history
            ownershipHistory: ownershipHistory,

            qualityAssurance: {
              testsPerformed: dbBatch.qualityTests?.length || 0,
              latestTest: dbBatch.qualityTests?.[0]
                ? {
                    testType: dbBatch.qualityTests[0].testType,
                    result: dbBatch.qualityTests[0].passFailStatus,
                    date: dbBatch.qualityTests[0].testDate,
                    inspector: "Quality Inspector",
                    facility: "Quality Lab",
                  }
                : null,
            },
          }
        : null,

      // Batch lineage (parent/child relationships from splitting)
      lineage: lineageInfo,

      message: "Batch verified successfully",
    };

    console.log("✅ Verification Response Summary:", {
      batchId: verificationResponse.batchId,
      batchStatus: dbBatch?.status,
      hasOwnershipHistory:
        verificationResponse.supplyChainSummary?.ownershipHistory?.length || 0,
      processingStages:
        verificationResponse.supplyChainSummary?.processingStages?.length || 0,
      distributionStages:
        verificationResponse.supplyChainSummary?.distributionStages?.length ||
        0,
      ownershipHistoryData:
        verificationResponse.supplyChainSummary?.ownershipHistory,
    });

    res.json(verificationResponse);
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      verified: false,
      error: "Internal server error",
      verificationTime: new Date().toISOString(),
    });
  }
});

// Update user profile
app.put("/api/auth/profile", authenticate, async (req, res) => {
  try {
    const { profileData, personalData } = req.body;
    const userId = req.user.id;

    // Update basic user info if provided
    const userUpdateData = {};
    if (personalData?.email && personalData.email !== req.user.email) {
      // Check if email already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          email: personalData.email,
          NOT: { id: userId },
        },
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: "Email already in use",
        });
      }
      userUpdateData.email = personalData.email;
    }

    if (personalData?.username && personalData.username !== req.user.username) {
      // Check if username already exists
      const existingUser = await prisma.user.findFirst({
        where: {
          username: personalData.username,
          NOT: { id: userId },
        },
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: "Username already in use",
        });
      }
      userUpdateData.username = personalData.username;
    }

    // Update user if there are changes
    if (Object.keys(userUpdateData).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdateData,
      });
    }

    // Update role-specific profile
    let updatedProfile = null;

    switch (req.user.role) {
      case "FARMER":
        updatedProfile = await prisma.farmerProfile.update({
          where: { userId: userId },
          data: {
            firstName: profileData.firstName,
            lastName: profileData.lastName,
            phone: profileData.phone,
            farmName: profileData.farmName,
            farmSize: profileData.farmSize
              ? parseFloat(profileData.farmSize)
              : null,
            address: profileData.address,
            state: profileData.state,
            primaryCrops: profileData.primaryCrops || [],
            farmingType: profileData.farmingType || [],
            certifications: profileData.certifications || [],
            licenseNumber: profileData.licenseNumber,
            profileImage: profileData.profileImage,
          },
        });
        break;

      case "PROCESSOR":
        updatedProfile = await prisma.processorProfile.update({
          where: { userId: userId },
          data: {
            companyName: profileData.companyName,
            contactPerson: profileData.contactPerson,
            phone: profileData.phone,
            email: profileData.email,
            address: profileData.address,
            state: profileData.state,
            facilityType: profileData.facilityType || [],
            processingCapacity: profileData.processingCapacity
              ? parseFloat(profileData.processingCapacity)
              : null,
            certifications: profileData.certifications || [],
            licenseNumber: profileData.licenseNumber,
          },
        });
        // ⭐ GEOCoding Logic: Check if address changed
        if (profileData.address) {
          const geocodeResult = await geocodeAddress(
            profileData.address,
            profileData.state,
            profileData.country
          );

          if (geocodeResult) {
            // Store coordinates in standard columns
            updateData.latitude = geocodeResult.latitude;
            updateData.longitude = geocodeResult.longitude;
          }
        }

        const modelToUpdate =
          req.user.role === "PROCESSOR"
            ? prisma.processorProfile
            : prisma.retailerProfile;

        updatedProfile = await modelToUpdate.update({
          where: { userId: userId },
          data: updateData,
        });

        // ⭐ POSTGIS LOGIC: Update geometry column
        if (updatedProfile.latitude && updatedProfile.longitude) {
          await updateGeometryPoint(
            `"${req.user.role.toLowerCase()}_profiles"`,
            updatedProfile.id,
            updatedProfile.latitude,
            updatedProfile.longitude
          );
        }
        break;

      case "ADMIN":
        updatedProfile = await prisma.adminProfile.update({
          where: { userId: userId },
          data: {
            firstName: profileData.firstName,
            lastName: profileData.lastName,
            phone: profileData.phone,
            email: profileData.email,
            permissions: profileData.permissions || [],
          },
        });
        break;

      default:
        return res.status(400).json({
          success: false,
          error: "Profile update not supported for this role",
        });
    }

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: userId,
        action: "UPDATE_PROFILE",
        ipAddress: req.ip,
        userAgent: req.get("User-Agent"),
        metadata: { updatedFields: Object.keys(profileData) },
      },
    });

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: updatedProfile,
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update profile",
      details: error.message,
    });
  }
});

// Upload profile picture
app.post(
  "/api/auth/profile/avatar",
  authenticate,
  upload.single("avatar"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No image file provided",
        });
      }

      const imageUrl = `/uploads/profiles/${req.file.filename}`;

      // Update profile image in database based on user role
      let updatedProfile = null;

      switch (req.user.role) {
        case "FARMER":
          updatedProfile = await prisma.farmerProfile.update({
            where: { userId: req.user.id },
            data: { profileImage: imageUrl },
          });
          break;

        case "PROCESSOR":
          // For processor, we might store it in a different field or table
          // For now, let's add a profileImage field to processor profile too
          break;

        case "ADMIN":
          // Similar handling for admin
          break;
      }

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_PROFILE_PICTURE",
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: { imageUrl: imageUrl },
        },
      });

      res.json({
        success: true,
        message: "Profile picture uploaded successfully",
        imageUrl: imageUrl,
        profile: updatedProfile,
      });
    } catch (error) {
      console.error("Profile picture upload error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to upload profile picture",
        details: error.message,
      });
    }
  }
);
// Update batch status (ENHANCED)
app.put(
  "/api/batch/:batchId/status",
  authenticate,
  authorize(["FARMER", "PROCESSOR", "DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const { status, updatedBy, notes } = req.body;

      // Get batch from database
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        include: {
          farmer: true,
          processingRecords: {
            include: { processor: true },
          },
          transportRoutes: {
            include: { distributor: true },
          },
        },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: `Batch ${batchId} not found`,
        });
      }

      // Check authorization based on role and batch ownership
      let canUpdate = false;

      switch (req.user.role) {
        case "FARMER":
          canUpdate = batch.farmer.userId === req.user.id;
          break;
        case "PROCESSOR":
          canUpdate = batch.processingRecords.some(
            (record) => record.processor.userId === req.user.id
          );
          break;
        case "DISTRIBUTOR":
          canUpdate = batch.transportRoutes.some(
            (route) => route.distributor.userId === req.user.id
          );
          break;
        case "ADMIN":
          canUpdate = true;
          break;
      }

      if (!canUpdate) {
        return res.status(403).json({
          success: false,
          error: "You cannot update this batch status",
        });
      }

      // Update database
      const updatedBatch = await prisma.batch.update({
        where: { batchId: batchId },
        data: {
          status: status,
          notes: notes || batch.notes,
          updatedAt: new Date(),
        },
      });

      // Update blockchain
      const { gateway, contract } = await blockchainService.connectToNetwork();
      if (contract) {
        try {
          const result = await blockchainService.submitTransactionWithRetry(
            contract,
            "updateBatchStatus",
            [
              batchId,
              status,
              updatedBy || req.user.username,
              new Date().toISOString(),
            ]
          );
          await gateway.disconnect();
        } catch (blockchainError) {
          await gateway.disconnect();
          console.error("Blockchain update failed:", blockchainError);
          // Continue anyway - database is updated
        }
      }

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_BATCH_STATUS",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: {
            newStatus: status,
            oldStatus: batch.status,
            notes: notes,
          },
        },
      });

      res.json({
        success: true,
        batchId: batchId,
        newStatus: status,
        oldStatus: batch.status,
        updatedBy: updatedBy || req.user.username,
        updatedAt: updatedBatch.updatedAt,
        message: "Batch status updated successfully",
      });
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  }
);

// Get all batches (ENHANCED - Admin/Regulator only)
app.get(
  "/api/batches",
  authenticate,
  authorize(["ADMIN", "REGULATOR"]),
  async (req, res) => {
    try {
      const { page = 1, limit = 10, status, farmer, crop } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Build where clause for filtering
      const where = {};
      if (status) where.status = status;
      if (crop) where.productType = { contains: crop, mode: "insensitive" };
      if (farmer) {
        where.farmer = {
          user: {
            username: { contains: farmer, mode: "insensitive" },
          },
        };
      }

      // Get batches from database with pagination
      const batches = await prisma.batch.findMany({
        where,
        include: {
          farmer: {
            include: {
              user: { select: { username: true } },
            },
          },
          farmLocation: true,
          _count: {
            select: {
              processingRecords: true,
              transportRoutes: true,
              qualityTests: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: skip,
        take: parseInt(limit),
      });

      const totalCount = await prisma.batch.count({ where });

      // Also get blockchain data for comparison (if needed)
      let blockchainBatches = [];
      if (req.query.includeBlockchain === "true") {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();
        if (contract) {
          try {
            const result = await contract.evaluateTransaction("getAllBatches");
            blockchainBatches = JSON.parse(result.toString());
            await gateway.disconnect();
          } catch (blockchainError) {
            await gateway.disconnect();
            console.error("Blockchain query failed:", blockchainError);
          }
        }
      }

      res.json({
        success: true,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalCount,
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          hasNext: skip + parseInt(limit) < totalCount,
          hasPrev: parseInt(page) > 1,
        },
        filters: { status, farmer, crop },
        count: batches.length,
        batches: batches,
        ...(req.query.includeBlockchain === "true" && {
          blockchainData: {
            count: blockchainBatches.length,
            batches: formatBlockchainDates(blockchainBatches),
          },
        }),
      });
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  }
);

// ==================== ADMIN USER MANAGEMENT ENDPOINTS ====================

// Get all users with pagination, search, and filters
app.get(
  "/api/admin/users",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 10,
        search = "",
        role = "",
        status = "",
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Build where clause
      const where = {};

      // Search filter - searches across username, email, and profile names
      if (search) {
        where.OR = [
          { username: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          {
            farmerProfile: {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { farmName: { contains: search, mode: "insensitive" } },
              ],
            },
          },
          {
            processorProfile: {
              companyName: { contains: search, mode: "insensitive" },
            },
          },
          {
            distributorProfile: {
              companyName: { contains: search, mode: "insensitive" },
            },
          },
          {
            retailerProfile: {
              businessName: { contains: search, mode: "insensitive" },
            },
          },
          {
            adminProfile: {
              OR: [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        ];
      }

      // Role filter
      if (role) {
        where.role = role;
      }

      // Status filter
      if (status) {
        where.status = status;
      }

      // Build orderBy
      const orderBy = {};
      orderBy[sortBy] = sortOrder;

      // Fetch users with all profile relations
      const users = await prisma.user.findMany({
        where,
        include: {
          farmerProfile: true,
          processorProfile: true,
          distributorProfile: true,
          retailerProfile: true,
          adminProfile: true,
          regulatorProfile: true,
          _count: {
            select: {
              activityLogs: true,
              sessions: true,
            },
          },
        },
        orderBy,
        skip,
        take: parseInt(limit),
      });

      const totalCount = await prisma.user.count({ where });

      // Remove password from response
      const sanitizedUsers = users.map(({ password, ...user }) => user);

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "VIEW_USERS",
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: {
            filters: { search, role, status },
            resultCount: users.length,
          },
        },
      });

      res.json({
        success: true,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalCount,
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          hasNext: skip + parseInt(limit) < totalCount,
          hasPrev: parseInt(page) > 1,
        },
        filters: { search, role, status, sortBy, sortOrder },
        users: sanitizedUsers,
      });
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch users",
        details: error.message,
      });
    }
  }
);

// Get single user with full details and activity logs
app.get(
  "/api/admin/users/:userId",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { activityLimit = 20 } = req.query;

      // Fetch user with all relations
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          farmerProfile: {
            include: {
              farmLocations: true,
              batches: {
                select: {
                  id: true,
                  batchId: true,
                  status: true,
                  createdAt: true,
                },
                take: 10,
                orderBy: { createdAt: "desc" },
              },
            },
          },
          processorProfile: {
            include: {
              facilities: true,
              processingRecords: {
                select: {
                  id: true,
                  batchId: true,
                  processingDate: true,
                },
                take: 10,
                orderBy: { processingDate: "desc" },
              },
            },
          },
          distributorProfile: true,
          retailerProfile: true,
          adminProfile: true,
          regulatorProfile: true,
          sessions: {
            orderBy: { createdAt: "desc" },
            take: 5,
          },
          activityLogs: {
            orderBy: { timestamp: "desc" },
            take: parseInt(activityLimit),
          },
        },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Remove password
      const { password, ...userDetails } = user;

      // Get additional statistics
      const stats = {
        totalActivityLogs: await prisma.activityLog.count({
          where: { userId },
        }),
        totalSessions: await prisma.userSession.count({ where: { userId } }),
      };

      // Role-specific stats
      if (user.role === "FARMER" && user.farmerProfile) {
        stats.totalBatches = await prisma.batch.count({
          where: { farmerId: user.farmerProfile.id },
        });
        stats.totalFarmLocations = await prisma.farmLocation.count({
          where: { farmerId: user.farmerProfile.id },
        });
      } else if (user.role === "PROCESSOR" && user.processorProfile) {
        stats.totalProcessingRecords = await prisma.processingRecord.count({
          where: { processorId: user.processorProfile.id },
        });
      }

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "VIEW_USER_DETAILS",
          resource: userId,
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: { viewedUserId: userId, viewedUserRole: user.role },
        },
      });

      res.json({
        success: true,
        user: userDetails,
        stats,
      });
    } catch (error) {
      console.error("API error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch user details",
        details: error.message,
      });
    }
  }
);

// Update user profile
app.put(
  "/api/admin/users/:userId",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { personalData, profileData } = req.body;

      // Fetch current user to know their role
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, email: true, username: true },
      });

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Security check: Prevent admin from editing their own account through this endpoint
      if (req.user.id === userId) {
        return res.status(403).json({
          success: false,
          error: "Use /api/auth/profile to update your own profile",
        });
      }

      // Update basic user info if provided
      const userUpdateData = {};

      if (personalData?.email && personalData.email !== currentUser.email) {
        // Check if email already exists
        const existingUser = await prisma.user.findFirst({
          where: {
            email: personalData.email,
            NOT: { id: userId },
          },
        });

        if (existingUser) {
          return res.status(400).json({
            success: false,
            error: "Email already in use",
          });
        }
        userUpdateData.email = personalData.email;
      }

      if (
        personalData?.username &&
        personalData.username !== currentUser.username
      ) {
        // Check if username already exists
        const existingUser = await prisma.user.findFirst({
          where: {
            username: personalData.username,
            NOT: { id: userId },
          },
        });

        if (existingUser) {
          return res.status(400).json({
            success: false,
            error: "Username already in use",
          });
        }
        userUpdateData.username = personalData.username;
      }

      // Update user if there are changes
      if (Object.keys(userUpdateData).length > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: userUpdateData,
        });
      }

      // Update role-specific profile
      let updatedProfile = null;

      switch (currentUser.role) {
        case "FARMER":
          updatedProfile = await prisma.farmerProfile.update({
            where: { userId: userId },
            data: {
              firstName: profileData.firstName,
              lastName: profileData.lastName,
              phone: profileData.phone,
              farmName: profileData.farmName,
              farmSize: profileData.farmSize
                ? parseFloat(profileData.farmSize)
                : null,
              address: profileData.address,
              state: profileData.state,
              primaryCrops: profileData.primaryCrops || [],
              farmingType: profileData.farmingType || [],
              certifications: profileData.certifications || [],
              licenseNumber: profileData.licenseNumber,
            },
          });
          break;

        case "PROCESSOR":
          updatedProfile = await prisma.processorProfile.update({
            where: { userId: userId },
            data: {
              companyName: profileData.companyName,
              contactPerson: profileData.contactPerson,
              phone: profileData.phone,
              email: profileData.email,
              address: profileData.address,
              state: profileData.state,
              facilityType: profileData.facilityType || [],
              processingCapacity: profileData.processingCapacity
                ? parseFloat(profileData.processingCapacity)
                : null,
              certifications: profileData.certifications || [],
              licenseNumber: profileData.licenseNumber,
            },
          });
          break;

        case "DISTRIBUTOR":
          updatedProfile = await prisma.distributorProfile.update({
            where: { userId: userId },
            data: {
              companyName: profileData.companyName,
              contactPerson: profileData.contactPerson,
              phone: profileData.phone,
              email: profileData.email,
              address: profileData.address,
              state: profileData.state,
              distributionType: profileData.distributionType || [],
              vehicleTypes: profileData.vehicleTypes || [],
              storageCapacity: profileData.storageCapacity
                ? parseFloat(profileData.storageCapacity)
                : null,
              licenseNumber: profileData.licenseNumber,
            },
          });
          break;

        case "RETAILER":
          updatedProfile = await prisma.retailerProfile.update({
            where: { userId: userId },
            data: {
              businessName: profileData.businessName,
              contactPerson: profileData.contactPerson,
              phone: profileData.phone,
              email: profileData.email,
              address: profileData.address,
              state: profileData.state,
              businessType: profileData.businessType || [],
              storageCapacity: profileData.storageCapacity
                ? parseFloat(profileData.storageCapacity)
                : null,
              licenseNumber: profileData.licenseNumber,
            },
          });
          break;

        case "ADMIN":
          updatedProfile = await prisma.adminProfile.update({
            where: { userId: userId },
            data: {
              firstName: profileData.firstName,
              lastName: profileData.lastName,
              phone: profileData.phone,
              email: profileData.email,
              permissions: profileData.permissions || [],
            },
          });
          break;

        default:
          return res.status(400).json({
            success: false,
            error: "Profile update not supported for this role",
          });
      }

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADMIN_UPDATE_USER_PROFILE",
          resource: userId,
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: {
            updatedUserId: userId,
            updatedUserRole: currentUser.role,
            updatedFields: [
              ...Object.keys(userUpdateData),
              ...Object.keys(profileData),
            ],
          },
        },
      });

      res.json({
        success: true,
        message: "User profile updated successfully",
        profile: updatedProfile,
      });
    } catch (error) {
      console.error("Profile update error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update user profile",
        details: error.message,
      });
    }
  }
);

// Change user role
app.put(
  "/api/admin/users/:userId/role",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { newRole, confirmDataLoss } = req.body;

      // Validate new role
      const validRoles = [
        "FARMER",
        "PROCESSOR",
        "DISTRIBUTOR",
        "RETAILER",
        "ADMIN",
        "REGULATOR",
      ];
      if (!validRoles.includes(newRole)) {
        return res.status(400).json({
          success: false,
          error: "Invalid role",
        });
      }

      // Fetch current user
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          email: true,
          farmerProfile: { select: { id: true } },
          processorProfile: { select: { id: true } },
        },
      });

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Prevent modifying SUPER_ADMIN
      if (currentUser.role === "SUPER_ADMIN") {
        return res.status(403).json({
          success: false,
          error: "Cannot modify SUPER_ADMIN role",
        });
      }

      // Check if same role
      if (currentUser.role === newRole) {
        return res.status(400).json({
          success: false,
          error: "User already has this role",
        });
      }

      // Check for active batches if changing from FARMER
      if (currentUser.role === "FARMER" && currentUser.farmerProfile) {
        const activeBatches = await prisma.batch.count({
          where: {
            farmerId: currentUser.farmerProfile.id,
            status: { in: ["PENDING", "IN_PROGRESS", "PROCESSING"] },
          },
        });

        if (activeBatches > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot change role: User has ${activeBatches} active batch(es)`,
          });
        }
      }

      // Check for active processing records if changing from PROCESSOR
      if (currentUser.role === "PROCESSOR" && currentUser.processorProfile) {
        const activeRecords = await prisma.processingRecord.count({
          where: {
            processorId: currentUser.processorProfile.id,
            status: { in: ["PENDING", "IN_PROGRESS"] },
          },
        });

        if (activeRecords > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot change role: User has ${activeRecords} active processing record(s)`,
          });
        }
      }

      // Require confirmation
      if (!confirmDataLoss) {
        return res.status(400).json({
          success: false,
          error:
            "Role change requires data migration. Set confirmDataLoss: true to proceed.",
        });
      }

      // Perform role change in transaction
      await prisma.$transaction(async (tx) => {
        // Delete old profile
        switch (currentUser.role) {
          case "FARMER":
            if (currentUser.farmerProfile) {
              await tx.farmerProfile.delete({
                where: { userId: userId },
              });
            }
            break;
          case "PROCESSOR":
            if (currentUser.processorProfile) {
              await tx.processorProfile.delete({
                where: { userId: userId },
              });
            }
            break;
          case "DISTRIBUTOR":
            await tx.distributorProfile.deleteMany({ where: { userId } });
            break;
          case "RETAILER":
            await tx.retailerProfile.deleteMany({ where: { userId } });
            break;
          case "ADMIN":
            await tx.adminProfile.deleteMany({ where: { userId } });
            break;
          case "REGULATOR":
            await tx.regulatorProfile.deleteMany({ where: { userId } });
            break;
        }

        // Update role
        await tx.user.update({
          where: { id: userId },
          data: { role: newRole },
        });

        // Create new profile
        switch (newRole) {
          case "FARMER":
            await tx.farmerProfile.create({
              data: { userId },
            });
            break;
          case "PROCESSOR":
            await tx.processorProfile.create({
              data: { userId },
            });
            break;
          case "DISTRIBUTOR":
            await tx.distributorProfile.create({
              data: { userId },
            });
            break;
          case "RETAILER":
            await tx.retailerProfile.create({
              data: { userId },
            });
            break;
          case "ADMIN":
            await tx.adminProfile.create({
              data: { userId },
            });
            break;
          case "REGULATOR":
            await tx.regulatorProfile.create({
              data: { userId },
            });
            break;
        }

        // Log activity
        await tx.activityLog.create({
          data: {
            userId: req.user.id,
            action: "ADMIN_CHANGE_USER_ROLE",
            resource: userId,
            ipAddress: req.ip,
            userAgent: req.get("User-Agent"),
            metadata: {
              targetUserId: userId,
              oldRole: currentUser.role,
              newRole: newRole,
            },
          },
        });
      });

      res.json({
        success: true,
        message: `User role changed from ${currentUser.role} to ${newRole}`,
      });
    } catch (error) {
      console.error("Role change error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to change user role",
        details: error.message,
      });
    }
  }
);

// Change user status
app.put(
  "/api/admin/users/:userId/status",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { status, reason } = req.body;

      // Validate status
      const validStatuses = ["ACTIVE", "SUSPENDED", "INACTIVE", "PENDING"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: "Invalid status",
        });
      }

      // Fetch current user
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, status: true },
      });

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Prevent self-suspension
      if (req.user.id === userId) {
        return res.status(403).json({
          success: false,
          error: "Cannot change your own status",
        });
      }

      // Prevent SUPER_ADMIN suspension
      if (currentUser.role === "SUPER_ADMIN") {
        return res.status(403).json({
          success: false,
          error: "Cannot change SUPER_ADMIN status",
        });
      }

      // Check if already has this status
      if (currentUser.status === status) {
        return res.status(400).json({
          success: false,
          error: "User already has this status",
        });
      }

      // Update status
      await prisma.user.update({
        where: { id: userId },
        data: { status },
      });

      // Invalidate all sessions if suspended or inactive
      if (status === "SUSPENDED" || status === "INACTIVE") {
        await prisma.userSession.deleteMany({
          where: { userId: userId },
        });
      }

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADMIN_CHANGE_USER_STATUS",
          resource: userId,
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
          metadata: {
            targetUserId: userId,
            oldStatus: currentUser.status,
            newStatus: status,
            reason: reason || "No reason provided",
          },
        },
      });

      res.json({
        success: true,
        message: `User status changed to ${status}`,
        sessionsInvalidated:
          status === "SUSPENDED" || status === "INACTIVE" ? true : false,
      });
    } catch (error) {
      console.error("Status change error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to change user status",
        details: error.message,
      });
    }
  }
);

// Delete user
app.delete(
  "/api/admin/users/:userId",
  authenticate,
  authorize(["ADMIN"]),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { confirm, hardDelete = false } = req.body;

      // Require confirmation
      if (!confirm) {
        return res.status(400).json({
          success: false,
          error: "Deletion requires confirmation. Set confirm: true",
        });
      }

      // Fetch current user
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          role: true,
          email: true,
          farmerProfile: { select: { id: true } },
          processorProfile: { select: { id: true } },
        },
      });

      if (!currentUser) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Prevent self-deletion
      if (req.user.id === userId) {
        return res.status(403).json({
          success: false,
          error: "Cannot delete your own account",
        });
      }

      // Prevent SUPER_ADMIN deletion
      if (currentUser.role === "SUPER_ADMIN") {
        return res.status(403).json({
          success: false,
          error: "Cannot delete SUPER_ADMIN account",
        });
      }

      // Check for active batches
      if (currentUser.role === "FARMER" && currentUser.farmerProfile) {
        const activeBatches = await prisma.batch.count({
          where: {
            farmerId: currentUser.farmerProfile.id,
            status: { in: ["PENDING", "IN_PROGRESS", "PROCESSING"] },
          },
        });

        if (activeBatches > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot delete: User has ${activeBatches} active batch(es)`,
          });
        }
      }

      // Check for active processing records
      if (currentUser.role === "PROCESSOR" && currentUser.processorProfile) {
        const activeRecords = await prisma.processingRecord.count({
          where: {
            processorId: currentUser.processorProfile.id,
            status: { in: ["PENDING", "IN_PROGRESS"] },
          },
        });

        if (activeRecords > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot delete: User has ${activeRecords} active processing record(s)`,
          });
        }
      }

      if (hardDelete) {
        // Hard delete - GDPR compliance
        await prisma.$transaction(async (tx) => {
          // Delete sessions
          await tx.userSession.deleteMany({ where: { userId } });

          // Delete activity logs
          await tx.activityLog.deleteMany({ where: { userId } });

          // Delete role-specific profile
          switch (currentUser.role) {
            case "FARMER":
              if (currentUser.farmerProfile) {
                await tx.farmerProfile.delete({ where: { userId } });
              }
              break;
            case "PROCESSOR":
              if (currentUser.processorProfile) {
                await tx.processorProfile.delete({ where: { userId } });
              }
              break;
            case "DISTRIBUTOR":
              await tx.distributorProfile.deleteMany({ where: { userId } });
              break;
            case "RETAILER":
              await tx.retailerProfile.deleteMany({ where: { userId } });
              break;
            case "ADMIN":
              await tx.adminProfile.deleteMany({ where: { userId } });
              break;
            case "REGULATOR":
              await tx.regulatorProfile.deleteMany({ where: { userId } });
              break;
          }

          // Delete user
          await tx.user.delete({ where: { id: userId } });

          // Log deletion (by admin)
          await tx.activityLog.create({
            data: {
              userId: req.user.id,
              action: "ADMIN_HARD_DELETE_USER",
              resource: userId,
              ipAddress: req.ip,
              userAgent: req.get("User-Agent"),
              metadata: {
                deletedUserId: userId,
                deletedUserEmail: currentUser.email,
                deletedUserRole: currentUser.role,
              },
            },
          });
        });

        res.json({
          success: true,
          message: "User permanently deleted",
          deletionType: "hard",
        });
      } else {
        // Soft delete - mark as deleted
        await prisma.$transaction(async (tx) => {
          // Update user status
          await tx.user.update({
            where: { id: userId },
            data: {
              status: "INACTIVE",
              email: `deleted_${userId}@deleted.local`, // Prevent email conflicts
            },
          });

          // Delete all sessions
          await tx.userSession.deleteMany({ where: { userId } });

          // Log deletion
          await tx.activityLog.create({
            data: {
              userId: req.user.id,
              action: "ADMIN_SOFT_DELETE_USER",
              resource: userId,
              ipAddress: req.ip,
              userAgent: req.get("User-Agent"),
              metadata: {
                deletedUserId: userId,
                deletedUserEmail: currentUser.email,
                deletedUserRole: currentUser.role,
              },
            },
          });
        });

        res.json({
          success: true,
          message: "User soft deleted (status set to INACTIVE)",
          deletionType: "soft",
        });
      }
    } catch (error) {
      console.error("User deletion error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to delete user",
        details: error.message,
      });
    }
  }
);

// Get QR code for existing batch (ENHANCED)
app.get("/api/qr/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;
    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3001";

    // Check if batch exists in database first
    const dbBatch = await prisma.batch.findUnique({
      where: { batchId: batchId },
      select: { batchId: true, status: true, qrCodeHash: true },
    });

    // Also check blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();
    let blockchainExists = false;

    if (contract) {
      try {
        await contract.evaluateTransaction("getBatch", batchId);
        blockchainExists = true;
        await gateway.disconnect();
      } catch (blockchainError) {
        await gateway.disconnect();
        blockchainExists = !blockchainError.message.includes("does not exist");
      }
    }

    if (!dbBatch && !blockchainExists) {
      return res.status(404).json({
        success: false,
        error: `Batch ${batchId} not found`,
      });
    }

    // Generate BOTH QR codes
    const verificationQR = await blockchainService.generateQRCode(batchId);
    const processingQR = await blockchainService.generateProcessingQRCode(
      batchId
    );

    res.json({
      success: true,
      batchId: batchId,
      qrCode: verificationQR, // Backward compatibility
      qrCodes: {
        verification: verificationQR,
        processing: processingQR,
      },
      verificationUrl: `${FRONTEND_URL}/verify/${batchId}`,
      processingUrl: `${FRONTEND_URL}/process-batch/${batchId}`,
      batchStatus: dbBatch?.status || "unknown",
      sources: {
        database: !!dbBatch,
        blockchain: blockchainExists,
      },
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Dashboard endpoint (NEW)
app.get("/api/dashboard", authenticate, async (req, res) => {
  try {
    let dashboardData = {};

    switch (req.user.role) {
      case "FARMER":
        const farmerProfile = await prisma.farmerProfile.findUnique({
          where: { userId: req.user.id },
          include: {
            batches: {
              include: {
                _count: {
                  select: {
                    processingRecords: true,
                    transportRoutes: true,
                  },
                },
              },
            },
            farmLocations: true,
          },
        });

        dashboardData = {
          farmerInfo: {
            farmName: farmerProfile?.farmName,
            farmSize: farmerProfile?.farmSize,
            primaryCrops: farmerProfile?.primaryCrops,
          },
          statistics: {
            totalBatches: farmerProfile?.batches?.length || 0,
            activeBatches:
              farmerProfile?.batches?.filter((b) =>
                ["REGISTERED", "PROCESSING", "IN_TRANSIT"].includes(b.status)
              ).length || 0,
            completedBatches:
              farmerProfile?.batches?.filter((b) =>
                ["DELIVERED", "SOLD"].includes(b.status)
              ).length || 0,
            farmLocations: farmerProfile?.farmLocations?.length || 0,
          },
          recentBatches: farmerProfile?.batches?.slice(0, 5) || [],
        };
        break;

      case "ADMIN":
        const totalUsers = await prisma.user.count();
        const totalBatches = await prisma.batch.count();
        const activeUsers = await prisma.user.count({
          where: { status: "ACTIVE" },
        });

        const usersByRole = await prisma.user.groupBy({
          by: ["role"],
          _count: { role: true },
        });

        const batchesByStatus = await prisma.batch.groupBy({
          by: ["status"],
          _count: { status: true },
        });

        dashboardData = {
          systemStats: {
            totalUsers,
            totalBatches,
            activeUsers,
            usersByRole: usersByRole.reduce((acc, item) => {
              acc[item.role] = item._count.role;
              return acc;
            }, {}),
            batchesByStatus: batchesByStatus.reduce((acc, item) => {
              acc[item.status] = item._count.status;
              return acc;
            }, {}),
          },
          recentActivity: await prisma.activityLog.findMany({
            take: 10,
            orderBy: { timestamp: "desc" },
            include: {
              user: {
                select: { username: true, role: true },
              },
            },
          }),
        };
        break;

      default:
        dashboardData = {
          message: "Dashboard not configured for this role",
        };
    }

    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        email: req.user.email,
      },
      dashboard: dashboardData,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load dashboard",
    });
  }
});

// Data integrity check endpoint (NEW)
app.get("/api/batch/:batchId/integrity", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Get current database data
    const dbBatch = await prisma.batch.findUnique({
      where: { batchId: batchId },
    });

    if (!dbBatch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found in database",
      });
    }

    // Create current hash
    const currentHash = calculateStableHash(dbBatch);

    // Compare with stored hash
    const integrityValid = currentHash === dbBatch.dataHash;

    // Get blockchain verification if available
    const { gateway, contract } = await blockchainService.connectToNetwork();
    let blockchainVerification = null;

    if (contract) {
      try {
        const result = await contract.evaluateTransaction(
          "verifyBatchIntegrity",
          batchId,
          currentHash
        );
        blockchainVerification = JSON.parse(result.toString());
        await gateway.disconnect();
      } catch (blockchainError) {
        await gateway.disconnect();
        console.error("Blockchain integrity check failed:", blockchainError);
      }
    }

    res.json({
      success: true,
      batchId: batchId,
      integrityCheck: {
        valid: integrityValid,
        storedHash: dbBatch.dataHash,
        currentHash: currentHash,
        lastModified: dbBatch.updatedAt,
        message: integrityValid
          ? "Data integrity verified"
          : "Data has been modified",
      },
      blockchainVerification: blockchainVerification,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Integrity check error:", error);
    res.status(500).json({
      success: false,
      error: "Integrity check failed",
    });
  }
});

// ===============================
// BATCH SPLITTING ENDPOINTS
// ===============================

// Split a batch into smaller portions
app.post(
  "/api/batch/:batchId/split",
  authenticate,
  authorize(["FARMER", "PROCESSOR", "DISTRIBUTOR"]),
  async (req, res) => {
    let gateway = null;
    try {
      const { batchId } = req.params;
      const { splitQuantity, reason, buyerName, pricePerUnit } = req.body;

      // Connect to blockchain
      let contract = null;
      try {
        const connection = await blockchainService.connectToNetwork();
        gateway = connection.gateway;
        contract = connection.contract;
      } catch (bcConnError) {
        console.warn(
          "Blockchain connection failed, continuing with database only:",
          bcConnError.message
        );
      }

      // Find the original batch
      const dbBatch = await prisma.batch.findFirst({
        where: { batchId: batchId },
        include: {
          farmer: true,
          farmLocation: true,
        },
      });

      const batchTransfers = await prisma.batchTransfer.findFirst({
        where: { batchId: batchId },
        orderBy: { transferDate: "desc" },
      });

      if (!dbBatch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      // Validate split quantity
      const splitQty = parseFloat(splitQuantity);
      if (isNaN(splitQty) || splitQty <= 0) {
        return res.status(400).json({
          success: false,
          error: "Split quantity must be a positive number",
        });
      }

      if (splitQty >= dbBatch.quantity) {
        return res.status(400).json({
          success: false,
          error: `Split quantity (${splitQty}) must be less than batch quantity (${dbBatch.quantity})`,
        });
      }

      // Generate new batch ID
      const childCount = await prisma.batch.count({
        where: { parentBatchId: dbBatch.id },
      });
      const suffix = String.fromCharCode(65 + childCount); // A, B, C, etc.
      const newBatchId = `${batchId}-${suffix}`;

      // Calculate quantities
      const remainingQuantity = dbBatch.quantity - splitQty;
      const newPricePerUnit = pricePerUnit || dbBatch.pricePerUnit;
      const newTotalValue = splitQty * (newPricePerUnit || 0);

      // Record on blockchain first
      let blockchainResult = null;
      if (contract) {
        try {
          const splitData = JSON.stringify({
            reason: reason || "Batch split for distribution",
            splitBy: req.user.id,
            splitByRole: req.user.role,
            buyerName: buyerName || null,
            pricePerUnit: newPricePerUnit,
            totalBatchValue: newTotalValue,
          });

          const result = await contract.submitTransaction(
            "splitBatch",
            batchId,
            newBatchId,
            splitQty.toString(),
            splitData
          );
          blockchainResult = JSON.parse(result.toString());
          console.log(
            `Batch split recorded on blockchain: ${batchId} → ${newBatchId}`
          );
        } catch (blockchainError) {
          console.error("Blockchain split error:", blockchainError);
          // Continue with database-only if blockchain fails
        }
      }

      // Create child batch in database
      const childBatch = await prisma.batch.create({
        data: {
          batchId: newBatchId,
          farmerId: dbBatch.farmerId,
          farmLocationId: dbBatch.farmLocationId,
          productType: dbBatch.productType,
          variety: dbBatch.variety,
          quantity: splitQty,
          unit: dbBatch.unit,
          harvestDate: dbBatch.harvestDate,
          status: dbBatch.status,
          cultivationMethod: dbBatch.cultivationMethod,
          seedsSource: dbBatch.seedsSource,
          irrigationMethod: dbBatch.irrigationMethod,
          fertilizers: dbBatch.fertilizers,
          pesticides: dbBatch.pesticides,
          qualityGrade: dbBatch.qualityGrade,
          moistureContent: dbBatch.moistureContent,
          cropType: dbBatch.cropType,
          proteinContent: dbBatch.proteinContent,
          certifications: dbBatch.certifications,
          customCertification: dbBatch.customCertification,
          pricePerUnit: newPricePerUnit,
          currency: dbBatch.currency,
          totalBatchValue: newTotalValue,
          paymentMethod: dbBatch.paymentMethod,
          buyerName: buyerName || dbBatch.buyerName,
          parentBatchId: dbBatch.id,
          splitReason: reason || "Batch split for distribution",
          splitDate: new Date(),
          blockchainHash: blockchainResult?.txId || null,
        },
      });

      // await prisma.batchTransfer.create({
      //   data: {
      //     batchId: newBatchId,
      //     fromActorId: req.user.id,
      //     fromActorRole: req.user.role,
      //     toActorId: req.user.id,
      //     toActorRole: req.user.role,
      //     transferType: "BATCH_SPLIT",
      //     transferDate: new Date(),
      //     notes: `Split from parent batch ${batchId}: ${splitQty} ${dbBatch.unit}`,
      //     status: "COMPLETED",
      //     statusBefore: dbBatch.status,
      //     statusAfter: dbBatch.status,
      //     blockchainTxId: blockchainResult?.txId || null,
      //   },
      // });

      await logBatchLocation(
        childBatch.id,
        "SPLIT_FROM_PARENT",
        batchTransfers?.latitude || 0,
        batchTransfers?.longitude || 0,
        {
          parentBatchId: dbBatch.batchId,
          reason: reason,
          originalQuantity: dbBatch.quantity,
          splitQuantity: splitQty,
        }
      );

      // Update parent batch quantity
      const updatedParentBatch = await prisma.batch.update({
        where: { id: dbBatch.id },
        data: {
          quantity: remainingQuantity,
          totalBatchValue: remainingQuantity * (dbBatch.pricePerUnit || 0),
        },
      });

      // Generate QR codes for the new batch
      let qrCodes = null;
      if (contract) {
        try {
          qrCodes = {
            verification: await blockchainService.generateQRCode(newBatchId),
            processing: await blockchainService.generateProcessingQRCode(
              newBatchId
            ),
          };
        } catch (qrError) {
          console.error("QR generation error:", qrError);
        }
      }

      // Log the activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "BATCH_SPLIT",
          resource: batchId,
          metadata: {
            parentBatchId: batchId,
            childBatchId: newBatchId,
            splitQuantity: splitQty,
            remainingQuantity: remainingQuantity,
            reason: reason,
          },
        },
      });

      res.status(201).json({
        success: true,
        message: `Batch split successfully: ${batchId} → ${newBatchId}`,
        parentBatch: {
          batchId: batchId,
          remainingQuantity: remainingQuantity,
          unit: dbBatch.unit,
        },
        childBatch: {
          batchId: newBatchId,
          quantity: splitQty,
          unit: childBatch.unit,
          parentBatchId: batchId,
          qrCodes: qrCodes,
        },
        blockchainRecorded: !!blockchainResult,
        blockchainTxId: blockchainResult?.txId || null,
      });

      // Disconnect gateway
      if (gateway) {
        await gateway.disconnect();
      }
    } catch (error) {
      console.error("Batch split error:", error);
      // Disconnect gateway on error
      if (gateway) {
        try {
          await gateway.disconnect();
        } catch (e) {}
      }
      res.status(500).json({
        success: false,
        error: "Failed to split batch",
        details: error.message,
      });
    }
  }
);
// Fixed endpoint with proper null checks
app.get("/api/batches/all-with-lineage", authenticate, async (req, res) => {
  let gateway = null;
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: "Authentication required. User not found in request.",
      });
    }
    const userId = req.user.id;
    const userRole = req.user.role;
    let connection = null;
    let contract = null;

    try {
      connection = await blockchainService.connectToNetwork();
      gateway = connection?.gateway;
      contract = connection?.contract;
    } catch (bcError) {
      console.warn(
        "Blockchain connection failed, continuing without it:",
        bcError.message
      );
    }

    let whereClause = {};

    if (userRole === "FARMER") {
      // Fetch the farmer profile
      const farmerProfile = await prisma.farmerProfile.findUnique({
        where: { userId: userId },
      });

      // Check if farmerProfile exists
      if (!farmerProfile) {
        console.error(
          `❌ Profile mismatch: User ${userId} has role FARMER but no profile record.`
        );
        return res.status(404).json({
          success: false,
          error: "Farmer profile record not found.",
        });
      }

      whereClause = { farmerId: farmerProfile.id };
    }
    // For other roles (ADMIN, PROCESSOR, etc.), whereClause remains {} to fetch all batches

    // Fetch all batches with proper includes
    const allBatches = await prisma.batch.findMany({
      where: whereClause,
      include: {
        farmer: {
          select: {
            id: true, // Include id for safety
            firstName: true,
            lastName: true,
            farmName: true,
          },
        },
      },
    });

    // Filter out batches with missing farmer profiles
    const validBatches = allBatches.filter((batch) => {
      if (!batch.farmer) {
        console.warn(
          `⚠️ Batch ${batch.batchId} has no associated farmer profile - skipping`
        );
        return false;
      }
      return true;
    });

    if (validBatches.length === 0) {
      return res.json({
        success: true,
        count: 0,
        batchesData: [],
        message: "No valid batches found",
      });
    }

    // Get parent IDs for lineage tracking
    const parentIds = [
      ...new Set(validBatches.map((b) => b.parentBatchId).filter(Boolean)),
    ];

    const parents = await prisma.batch.findMany({
      where: { id: { in: parentIds } },
    });

    const parentLookup = new Map(parents.map((p) => [p.id, p]));

    // Process each batch to build history and routes
    const batchesData = await Promise.all(
      validBatches.map(async (currentBatch) => {
        const getFormattedPoints = async (targetId, limitDate = null) => {
          const filter = limitDate ? { lte: limitDate } : {};

          const [locations, processing, distribution, transfers] =
            await Promise.all([
              prisma.batchLocationHistory.findMany({
                where: { batchId: targetId, timestamp: filter },
              }),
              prisma.processingRecord.findMany({
                where: { batchId: targetId, processingDate: filter },
              }),
              prisma.distributionRecord.findMany({
                where: { batchIDHash: targetId, distributionDate: filter },
              }),
              prisma.batchTransfer.findMany({
                where: { batchId: currentBatch.batchId, transferDate: filter },
              }),
            ]);

          // Get blockchain history if available
          let blockchainHistory = [];
          if (contract) {
            try {
              const historyResult = await contract.evaluateTransaction(
                "getBatchHistory",
                currentBatch.batchId
              );
              const historyData = JSON.parse(historyResult.toString());
              blockchainHistory = historyData.statusHistory || [];
            } catch (e) {
              console.warn(
                `Could not fetch blockchain history for ${currentBatch.batchId}`
              );
            }
          }

          // Helper function to verify blockchain records
          const getBcVerification = (dbTimestamp, status) => {
            const match = blockchainHistory.find((bh) => {
              if (bh.status !== status) return false;

              let bcTimestamp;
              if (/^\d+(\.\d+)?$/.test(bh.timestamp)) {
                bcTimestamp = parseFloat(bh.timestamp) * 1000;
              } else {
                bcTimestamp = new Date(bh.timestamp).getTime();
              }

              const dbTimestampMs = new Date(dbTimestamp).getTime();
              const timeDiff = Math.abs(bcTimestamp - dbTimestampMs);
              return timeDiff < 300000; // 5 minute tolerance
            });

            return match
              ? {
                  txId: match.txId,
                  verifiedBy: match.updatedBy,
                  isImmutable: true,
                  blockchainTimestamp: match.timestamp,
                }
              : null;
          };

          const parentInfo = currentBatch.parentBatchId
            ? parentLookup.get(currentBatch.parentBatchId)
            : null;

          return [
            ...locations.map((l) => ({
              eventType: l.eventType,
              latitude: l.latitude,
              longitude: l.longitude,
              timestamp: l.timestamp,
              metadata: {
                ...l.metadata,
                stage: l.eventType,
                location: l.metadata?.location || "Farm",
                isParentPath: limitDate !== null,
                splitTimestamp: limitDate
                  ? new Date(limitDate).getTime()
                  : null,
                temperature: l.metadata?.temperature || null,
                humidity: l.metadata?.humidity || null,
                weather_main: l.metadata?.weather_main || null,
                weather_desc: l.metadata?.weather_desc || null,
                parentBatch: parentInfo ? parentInfo.batchId : null,
                blockchain: getBcVerification(l.timestamp, l.eventType),
              },
            })),
            ...processing.map((p) => ({
              eventType: "PROCESSING",
              latitude: p.latitude,
              longitude: p.longitude,
              timestamp: p.processingDate,
              metadata: {
                location: p.processingLocation,
                temperature: p.temperature,
                humidity: p.humidity,
                weather_main: p.weather_main,
                weather_desc: p.weather_desc,
                stage: "Processing",
                blockchain: getBcVerification(p.processingDate, "PROCESSING"),
              },
            })),
            ...distribution.map((d) => ({
              eventType: "DISTRIBUTION_ARRIVAL",
              latitude: d.warehouseLat,
              longitude: d.warehouseLng,
              timestamp: d.distributionDate,
              metadata: {
                location: d.warehouseLocation,
                temperature: d.temperature,
                humidity: d.humidity,
                weather_main: d.weather_main,
                weather_desc: d.weather_desc,
                stage: "Distribution",
                blockchain: getBcVerification(
                  d.distributionDate,
                  "IN_DISTRIBUTION"
                ),
              },
            })),
            ...transfers.map((t) => ({
              eventType: "RETAIL_READY",
              latitude: parseFloat(t.latitude),
              longitude: parseFloat(t.longitude),
              timestamp: t.transferDate,
              metadata: {
                location: t.transferLocation,
                notes: t.notes,
                temperature: t.temperature,
                humidity: t.humidity,
                weather_main: t.weather_main,
                weather_desc: t.weather_desc,
                stage: "Retail",
                blockchain: getBcVerification(t.transferDate, "RETAIL_READY"),
              },
            })),
          ];
        };

        const getFormattedRoutes = async (targetId, limitDate = null) => {
          const filter = limitDate ? { timestamp: { lte: limitDate } } : {};
          const routes = await prisma.transportRoute.findMany({
            where: {
              OR: [{ batchId: targetId }, { batchIdName: targetId }],
              ...filter,
            },
            orderBy: { departureTime: "asc" },
          });

          return routes.map((route) => ({
            ...route,
            isParentPath: limitDate !== null,
            splitTimestamp: limitDate ? new Date(limitDate).getTime() : null,
            timestamp: route.timestamp
              ? new Date(route.timestamp).getTime()
              : 0,
            humidity: route.metadata?.humidity || null,
            temperature: route.metadata?.temperature || null,
          }));
        };

        let combinedPoints = [];
        let combinedRoutes = [];

        // Get parent batch history if this is a split batch
        if (currentBatch.parentBatchId && currentBatch.splitDate) {
          const [pPoints, pRoutes] = await Promise.all([
            getFormattedPoints(
              currentBatch.parentBatchId,
              currentBatch.splitDate
            ),
            getFormattedRoutes(
              currentBatch.parentBatchId,
              currentBatch.splitDate
            ),
          ]);
          combinedPoints.push(...pPoints);
          combinedRoutes.push(...pRoutes);
        }

        // Get current batch history
        const [cPoints, cRoutes] = await Promise.all([
          getFormattedPoints(currentBatch.id),
          getFormattedRoutes(currentBatch.id),
        ]);
        combinedPoints.push(...cPoints);
        combinedRoutes.push(...cRoutes);

        // Sort points chronologically
        combinedPoints.sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        return {
          batchId: currentBatch.batchId,
          status: currentBatch.status,
          cropType: currentBatch.cropType,
          quantity: currentBatch.quantity,
          productType: currentBatch.productType,
          historyPoints: combinedPoints,
          activeRoutes: combinedRoutes,
        };
      })
    );

    res.json({
      success: true,
      count: batchesData.length,
      batchesData: batchesData,
    });
  } catch (error) {
    console.error("Global history fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: error.message,
    });
  } finally {
    // Always disconnect gateway
    if (gateway) {
      try {
        await gateway.disconnect();
      } catch (e) {
        console.error("Error disconnecting gateway:", e);
      }
    }
  }
});

// Get batch lineage (parent and children)
app.get("/api/batch/:batchId/lineage", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Find the batch
    const batch = await prisma.batch.findFirst({
      where: { batchId: batchId },
      include: {
        farmer: {
          select: {
            firstName: true,
            lastName: true,
            farmName: true,
          },
        },
      },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    // Get parent batch if exists
    let parentBatch = null;
    if (batch.parentBatchId) {
      parentBatch = await prisma.batch.findUnique({
        where: { id: batch.parentBatchId },
        select: {
          batchId: true,
          quantity: true,
          unit: true,
          status: true,
          productType: true,
        },
      });
    }

    // Get child batches
    const childBatches = await prisma.batch.findMany({
      where: { parentBatchId: batch.id },
      select: {
        batchId: true,
        quantity: true,
        unit: true,
        status: true,
        splitReason: true,
        splitDate: true,
        buyerName: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Get blockchain lineage if connected
    let blockchainLineage = null;
    if (contract) {
      try {
        const result = await contract.evaluateTransaction(
          "getBatchLineage",
          batchId
        );
        blockchainLineage = JSON.parse(result.toString());
      } catch (bcError) {
        console.error("Blockchain lineage fetch error:", bcError);
      }
    }

    res.json({
      success: true,
      batch: {
        batchId: batch.batchId,
        quantity: batch.quantity,
        unit: batch.unit,
        status: batch.status,
        productType: batch.productType,
        isChild: !!batch.parentBatchId,
        isParent: childBatches.length > 0,
        splitReason: batch.splitReason,
        splitDate: batch.splitDate,
      },
      lineage: {
        parent: parentBatch,
        children: childBatches,
        totalChildren: childBatches.length,
      },
      blockchainLineage: blockchainLineage,
    });
  } catch (error) {
    console.error("Get lineage error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch batch lineage",
    });
  }
});

// Recall a batch - marks batch as RECALLED for safety/quality issues
app.post(
  "/api/batch/:batchId/recall",
  authenticate,
  authorize([
    "ADMIN",
    "REGULATOR",
    "FARMER",
    "PROCESSOR",
    "DISTRIBUTOR",
    "RETAILER",
  ]),
  async (req, res) => {
    let gateway = null;
    try {
      const { batchId } = req.params;
      const { reason, severity, notes, recallChildren } = req.body;

      // Validate required fields
      if (!reason || !reason.trim()) {
        return res.status(400).json({
          success: false,
          error: "Recall reason is required",
        });
      }

      // Find the batch in database with farmer info
      const dbBatch = await prisma.batch.findFirst({
        where: { batchId: batchId },
        include: {
          farmer: {
            select: { userId: true },
          },
          childBatches: {
            select: {
              id: true,
              batchId: true,
              quantity: true,
              unit: true,
              status: true,
            },
          },
        },
      });

      if (!dbBatch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      // Authorization check: Only farmer (creator) or current owner can recall
      // ADMIN and REGULATOR can always recall
      const isAdmin = req.user.role === "ADMIN";
      const isRegulator = req.user.role === "REGULATOR";
      const isFarmer = dbBatch.farmer?.userId === req.user.id;

      // Check if user is current owner via BatchTransfer
      let isCurrentOwner = false;
      if (!isAdmin && !isRegulator && !isFarmer) {
        const latestTransfer = await prisma.batchTransfer.findFirst({
          where: {
            batchId: batchId,
            status: "COMPLETED",
          },
          orderBy: { transferDate: "desc" },
        });

        if (latestTransfer && latestTransfer.toActorId === req.user.id) {
          isCurrentOwner = true;
        }
      }

      if (!isAdmin && !isRegulator && !isFarmer && !isCurrentOwner) {
        return res.status(403).json({
          success: false,
          error:
            "Only the batch creator (farmer) or current owner can recall this batch",
        });
      }

      // Check if already recalled
      if (dbBatch.status === "RECALLED") {
        return res.status(400).json({
          success: false,
          error: "Batch is already recalled",
        });
      }

      // Connect to blockchain
      let contract = null;
      try {
        const connection = await blockchainService.connectToNetwork();
        gateway = connection.gateway;
        contract = connection.contract;
      } catch (bcConnError) {
        console.warn(
          "Blockchain connection failed, continuing with database only:",
          bcConnError.message
        );
      }

      // Record on blockchain first
      let blockchainResult = null;
      if (contract) {
        try {
          const recallData = JSON.stringify({
            reason: reason,
            severity: severity || "HIGH",
            recalledBy: req.user.id,
            recalledByRole: req.user.role,
            notes: notes || null,
            recallChildren: recallChildren || false,
          });

          const result = await contract.submitTransaction(
            "recallBatch",
            batchId,
            recallData
          );
          blockchainResult = JSON.parse(result.toString());
          console.log(`Batch recall recorded on blockchain: ${batchId}`);
        } catch (blockchainError) {
          console.error("Blockchain recall error:", blockchainError);
          // Continue with database-only if blockchain fails
        }
      }

      // Update batch status and recall details in database
      const previousStatus = dbBatch.status;
      const recallDate = new Date();
      const updatedBatch = await prisma.batch.update({
        where: { id: dbBatch.id },
        data: {
          status: "RECALLED",
          recallReason: reason,
          recallSeverity: severity || "HIGH",
          recallNotes: notes || null,
          recalledAt: recallDate,
          recalledBy: req.user.id,
          recalledByRole: req.user.role,
        },
      });

      // Track affected batches
      const affectedBatches = [
        {
          batchId: batchId,
          quantity: dbBatch.quantity,
          unit: dbBatch.unit,
          previousStatus: previousStatus,
        },
      ];

      // Recall child batches if requested
      if (
        recallChildren &&
        dbBatch.childBatches &&
        dbBatch.childBatches.length > 0
      ) {
        for (const child of dbBatch.childBatches) {
          if (child.status !== "RECALLED") {
            await prisma.batch.update({
              where: { id: child.id },
              data: {
                status: "RECALLED",
                recallReason: `Cascade recall from parent batch ${batchId}: ${reason}`,
                recallSeverity: severity || "HIGH",
                recallNotes: `Parent batch recalled. Original reason: ${reason}`,
                recalledAt: recallDate,
                recalledBy: req.user.id,
                recalledByRole: req.user.role,
              },
            });

            affectedBatches.push({
              batchId: child.batchId,
              quantity: child.quantity,
              unit: child.unit,
              previousStatus: child.status,
              cascadeRecall: true,
            });
          }
        }
      }

      // Log the recall activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "BATCH_RECALL",
          resource: batchId,
          metadata: {
            reason: reason,
            severity: severity || "HIGH",
            affectedBatches: affectedBatches.length,
            recallChildren: recallChildren || false,
            notes: notes,
          },
        },
      });

      // Disconnect gateway
      if (gateway) {
        await gateway.disconnect();
      }

      res.status(200).json({
        success: true,
        message: `Batch ${batchId} has been recalled`,
        recallInfo: {
          reason: reason,
          severity: severity || "HIGH",
          recalledBy: req.user.id,
          recalledByRole: req.user.role,
          recallDate: new Date().toISOString(),
        },
        affectedBatches: affectedBatches,
        totalAffectedBatches: affectedBatches.length,
        blockchainRecorded: !!blockchainResult,
        blockchainTxId: blockchainResult?.txId || null,
      });
    } catch (error) {
      console.error("Batch recall error:", error);
      if (gateway) {
        try {
          await gateway.disconnect();
        } catch (e) {}
      }
      res.status(500).json({
        success: false,
        error: "Failed to recall batch",
        details: error.message,
      });
    }
  }
);

// Check if a batch is recalled
app.get("/api/batch/:batchId/recall-status", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = await prisma.batch.findFirst({
      where: { batchId: batchId },
      select: {
        batchId: true,
        status: true,
      },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    res.json({
      success: true,
      batchId: batchId,
      isRecalled: batch.status === "RECALLED",
    });
  } catch (error) {
    console.error("Check recall status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check recall status",
    });
  }
});

// ===============================
// PROCESSOR ENDPOINTS
// ===============================

// Get available batches for processing
app.get(
  "/api/processor/available-batches",
  authenticate,
  authorize(["PROCESSOR"]),
  async (req, res) => {
    try {
      const batches = await prisma.batch.findMany({
        where: {
          status: {
            in: ["REGISTERED", "PROCESSING"],
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          farmer: {
            select: {
              firstName: true,
              lastName: true,
              farmName: true,
              user: {
                select: {
                  username: true,
                },
              },
            },
          },
          farmLocation: {
            select: {
              location: true,
            },
          },
        },
      });

      res.json({
        success: true,
        batches: batches,
        message: `Found ${batches.length} batches (available and in processing)`,
      });
    } catch (error) {
      console.error("Get available batches error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch available batches",
      });
    }
  }
);

// Process a batch
app.post(
  "/api/processor/process/:batchId",
  authenticate,
  authorize(["PROCESSOR"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        processType,
        notes,
        processingLocation,
        latitude,
        longitude,
        inputQuantity,
        outputQuantity,
        wasteQuantity,
        processingTime,
        energyUsage,
        waterUsage,
        ...additionalData
      } = req.body;
      const processorId = req.user.id;

      // Find the batch with farmer info for transfer record
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        include: {
          farmer: {
            select: { userId: true },
          },
          farmLocation: true,
        },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      if (batch.status !== "REGISTERED") {
        return res.status(400).json({
          success: false,
          error: `Cannot process batch with status: ${batch.status}`,
        });
      }

      // Update batch status to PROCESSING
      const updatedBatch = await prisma.batch.update({
        where: { batchId: batchId },
        data: {
          status: "PROCESSING",
          updatedAt: new Date(),
        },
      });

      // Create BatchTransfer record for ownership transfer from Farmer to Processor (SC-01)
      await prisma.batchTransfer.create({
        data: {
          batchId: batchId,
          fromActorId: batch.farmer?.userId || batch.farmerId,
          fromActorRole: "FARMER",
          toActorId: processorId,
          toActorRole: "PROCESSOR",
          transferType: "OWNERSHIP_TRANSFER",
          transferDate: new Date(),
          notes: `Batch received by processor for processing`,
          status: "COMPLETED",
          statusBefore: "REGISTERED",
          statusAfter: "PROCESSING",
        },
      });

      // Get the processor profile ID
      const processorProfile = await prisma.processorProfile.findUnique({
        where: {
          userId: processorId,
        },
      });

      if (!processorProfile) {
        return res.status(400).json({
          success: false,
          error: "Processor profile not found",
        });
      }

      // Find or create a default processing facility for this processor
      let facility = await prisma.processingFacility.findFirst({
        where: {
          processorId: processorProfile.id,
          isActive: true,
        },
      });

      if (!facility) {
        // Create a default facility if none exists
        facility = await prisma.processingFacility.create({
          data: {
            processorId: processorProfile.id,
            facilityName: `${req.user.username}'s Processing Facility`,
            facilityType: "processing",
            latitude: 0.0, // Default coordinates, can be updated later
            longitude: 0.0,
            address: "Not specified",
            isActive: true,
            certifications: [],
            equipmentList: [],
          },
        });
      }

      // ========== HASH PROCESSING DATA FOR INTEGRITY ==========
      // Prepare critical processing data for cryptographic hashing
      const processingDataForHash = {
        batchId: batch.batchId, // Use string ID, not database ID
        processorId: processorProfile.id,
        facilityId: facility.id,
        processingType: processType || "initial_processing",
        inputQuantity: inputQuantity
          ? parseFloat(inputQuantity)
          : batch.quantity,
        outputQuantity: outputQuantity
          ? parseFloat(outputQuantity)
          : batch.quantity,
        wasteQuantity: wasteQuantity ? parseFloat(wasteQuantity) : null,
        processingTime: processingTime ? parseInt(processingTime) : null,
        energyUsage: energyUsage ? parseFloat(energyUsage) : null,
        waterUsage: waterUsage ? parseFloat(waterUsage) : null,
        operatorName: req.user.username,
        processingLocation: processingLocation || null,
        timestamp: new Date().toISOString(),
      };

      // Generate SHA-256 hash for data integrity verification
      const processingHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(processingDataForHash))
        .digest("hex");
      // ========== END HASH CALCULATION ==========

      // Create processing record with location tracking
      const processingRecord = await prisma.processingRecord.create({
        data: {
          batchId: batch.id,
          processorId: processorProfile.id,
          facilityId: facility.id,
          processingDate: new Date(),
          processingType: processType || "initial_processing",
          inputQuantity: inputQuantity
            ? parseFloat(inputQuantity)
            : batch.quantity,
          outputQuantity: outputQuantity
            ? parseFloat(outputQuantity)
            : batch.quantity,
          wasteQuantity: wasteQuantity ? parseFloat(wasteQuantity) : null,
          processingTime: processingTime ? parseInt(processingTime) : null,
          energyUsage: energyUsage ? parseFloat(energyUsage) : null,
          waterUsage: waterUsage ? parseFloat(waterUsage) : null,
          operatorName: req.user.username,
          // Location tracking
          processingLocation: processingLocation || null,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          temperature: additionalData.temperature
            ? parseFloat(additionalData.temperature)
            : null,
          humidity: additionalData.humidity
            ? parseFloat(additionalData.humidity)
            : null,
          weather_main: additionalData.weather_main || null,
          weather_desc: additionalData.weather_description || null,
          blockchainHash: processingHash, // ← INTEGRITY HASH
        },
      });

      if (batch.farmLocation && latitude && longitude) {
        const routeData = await getORSRoute(
          {
            lat: batch.farmLocation.latitude,
            lng: batch.farmLocation.longitude,
          },
          { lat: parseFloat(latitude), lng: parseFloat(longitude) }
        );

        if (routeData) {
          await prisma.transportRoute.create({
            data: {
              batch: { connect: { id: batch.id } },
              batchIdName: batch.batchId,
              distributorId: req.user.id,
              originLat: batch.farmLocation.latitude,
              originLng: batch.farmLocation.longitude,
              destinationLat: parseFloat(latitude),
              destinationLng: parseFloat(longitude),
              distance: parseFloat(routeData.distanceKm),
              estimatedTime: parseFloat(routeData.durationMinutes),
              // idea is the eta will be the diff between when the farmer registered it the crop and when the processor accepts it for processing
              TotalTime: Math.ceil(
                (processingRecord.processingDate.getTime() -
                  batch.createdAt.getTime()) /
                  60000
              ),
              timestamp: processingRecord.processingDate,
              routePolyline: routeData.geometry,
            },
          });
        }
      }

      // Update blockchain with processing details
      try {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();

        // Prepare processing data for blockchain
        const processingData = {
          processorId: req.user.username,
          processingType: processType || "initial_processing",
          processingLocation: processingLocation || null,
          latitude: latitude ? parseFloat(latitude) : null,
          longitude: longitude ? parseFloat(longitude) : null,
          inputQuantity: inputQuantity
            ? parseFloat(inputQuantity)
            : batch.quantity,
          outputQuantity: outputQuantity
            ? parseFloat(outputQuantity)
            : batch.quantity,
          wasteQuantity: wasteQuantity ? parseFloat(wasteQuantity) : null,
          processingTime: processingTime ? parseInt(processingTime) : null,
          energyUsage: energyUsage ? parseFloat(energyUsage) : null,
          waterUsage: waterUsage ? parseFloat(waterUsage) : null,
          processingDate: new Date().toISOString(),
        };

        await contract.submitTransaction(
          "updateBatchStatus",
          batchId,
          "PROCESSING",
          req.user.username,
          new Date().toISOString(),
          JSON.stringify(processingData)
        );
        await gateway.disconnect();
        console.log(
          `✅ Blockchain updated: Batch ${batchId} set to PROCESSING with location & quantity data`
        );
      } catch (blockchainError) {
        console.error("Blockchain update failed:", blockchainError);
      }

      res.json({
        success: true,
        batch: updatedBatch,
        processingRecord: processingRecord,
        message: "Batch processing started successfully",
      });
    } catch (error) {
      console.error("Process batch error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to start batch processing",
      });
    }
  }
);

// Get processor's processing history
app.get(
  "/api/processor/my-processing",
  authenticate,
  authorize(["PROCESSOR"]),
  async (req, res) => {
    try {
      const processorId = req.user.id;

      // Get the processor profile ID
      const processorProfile = await prisma.processorProfile.findUnique({
        where: {
          userId: processorId,
        },
      });

      if (!processorProfile) {
        return res.status(400).json({
          success: false,
          error: "Processor profile not found",
        });
      }

      const processingHistory = await prisma.processingRecord.findMany({
        where: {
          processorId: processorProfile.id,
        },
        orderBy: {
          processingDate: "desc",
        },
        include: {
          batch: {
            select: {
              batchId: true,
              productType: true,
              variety: true,
              status: true,
            },
          },
        },
      });

      // Transform data for frontend
      const history = processingHistory.map((record) => ({
        id: record.id,
        batchId: record.batch?.batchId || record.batchId,
        productType: record.batch?.productType || "Unknown",
        variety: record.batch?.variety,
        processType: record.processingType,
        processDate: record.processingDate,
        createdAt: record.processingDate, // For compatibility with dashboard
        status: "COMPLETED", // ProcessingRecord doesn't have a status field in our schema
        notes: record.operatorName
          ? `Processed by ${record.operatorName}`
          : "Processing completed",
      }));

      res.json({
        success: true,
        history: history,
        message: `Found ${history.length} processing records`,
      });
    } catch (error) {
      console.error("Get processing history error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch processing history",
      });
    }
  }
);

// Complete processing for a batch
app.put(
  "/api/processor/complete/:batchId",
  authenticate,
  authorize(["PROCESSOR"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const { qualityGrade, completionNotes, outputQuantity, wasteQuantity } =
        req.body;
      const processorId = req.user.id;

      // Get the processor profile ID
      const processorProfile = await prisma.processorProfile.findUnique({
        where: {
          userId: processorId,
        },
      });

      if (!processorProfile) {
        return res.status(400).json({
          success: false,
          error: "Processor profile not found",
        });
      }

      // Find the batch
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      if (batch.status !== "PROCESSING") {
        return res.status(400).json({
          success: false,
          error: `Cannot complete batch with status: ${batch.status}`,
        });
      }

      // Update batch status to PROCESSED
      const updatedBatch = await prisma.batch.update({
        where: { batchId: batchId },
        data: {
          status: "PROCESSED",
          qualityGrade: qualityGrade,
          updatedAt: new Date(),
        },
      });

      // Update processing record - update the most recent processing record for this batch and processor
      const mostRecentRecord = await prisma.processingRecord.findFirst({
        where: {
          batch: {
            batchId: batchId,
          },
          processorId: processorProfile.id,
        },
        orderBy: {
          processingDate: "desc",
        },
      });

      if (mostRecentRecord) {
        await prisma.processingRecord.update({
          where: {
            id: mostRecentRecord.id,
          },
          data: {
            outputQuantity: outputQuantity
              ? parseFloat(outputQuantity)
              : batch.quantity,
            wasteQuantity: wasteQuantity
              ? parseFloat(wasteQuantity)
              : mostRecentRecord.wasteQuantity,
            operatorName: `${req.user.username} (completed)`,
            // qualityTests: qualityGrade
            //   ? JSON.stringify({ grade: qualityGrade, notes: completionNotes })
            //   : null,
            qualityTests: { grade: qualityGrade, notes: completionNotes },
          },
        });
      }

      // Update blockchain with completion details including quantities
      try {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();
        await contract.submitTransaction(
          "updateBatchStatus",
          batchId,
          "PROCESSED",
          req.user.username,
          new Date().toISOString(),
          JSON.stringify({
            processedBy: req.user.username,
            processorId: processorId,
            completionDate: new Date().toISOString(),
            qualityGrade: qualityGrade,
            notes: completionNotes,
            // Include final quantities
            outputQuantity: outputQuantity
              ? parseFloat(outputQuantity)
              : batch.quantity,
            wasteQuantity: wasteQuantity ? parseFloat(wasteQuantity) : null,
            processingLocation: mostRecentRecord?.processingLocation || null,
            latitude: mostRecentRecord?.latitude || null,
            longitude: mostRecentRecord?.longitude || null,
          })
        );
        await gateway.disconnect();
        console.log(
          `✅ Blockchain updated: Batch ${batchId} completed processing with final quantities`
        );
      } catch (blockchainError) {
        console.error("Blockchain update failed:", blockchainError);
      }

      res.json({
        success: true,
        batch: updatedBatch,
        message: "Batch processing completed successfully",
      });
    } catch (error) {
      console.error("Complete processing error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to complete batch processing",
      });
    }
  }
);

app.get("/api/batches/active-locations", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let whereClause = {
      status: {
        in: [
          "REGISTERED",
          "PROCESSING",
          "PROCESSED",
          "IN_TRANSIT",
          "IN_DISTRIBUTION",
          "RETAIL_READY",
          "IN_RETAIL",
          "SOLD",
        ],
      },
    };

    if (userRole === "FARMER") {
      const farmerProfile = await prisma.farmerProfile.findUnique({
        where: { userId: userId },
      });

      if (!farmerProfile) {
        return res
          .status(404)
          .json({ success: false, error: "Farmer profile not found" });
      }

      whereClause.farmerId = farmerProfile.id;
    }

    const activeBatches = await prisma.batch.findMany({
      where: whereClause,
      include: {
        farmer: { select: { firstName: true, lastName: true, farmName: true } },
        farmLocation: true,
      },
    });

    if (activeBatches.length === 0) {
      return res.json({ success: true, batchesData: [] });
    }

    // 2. Extract IDs for bulk querying
    const internalIds = activeBatches.map((b) => b.id);
    const stringBatchIds = activeBatches.map((b) => b.batchId);

    // 3. Parallel Bulk Fetch: Execute all database hits at once
    const [allProcessing, allRoutes, allDistribution, allTransfers] =
      await Promise.all([
        prisma.processingRecord.findMany({
          where: { batchId: { in: internalIds } },
          include: {
            processor: { include: { user: { select: { username: true } } } },
          },
        }),
        prisma.transportRoute.findMany({
          where: {
            OR: [
              { batchId: { in: internalIds } },
              { batchIdName: { in: stringBatchIds } },
            ],
          },
        }),
        prisma.distributionRecord.findMany({
          where: { batchId: { in: stringBatchIds } },
        }),
        prisma.batchTransfer.findMany({
          where: { batchId: { in: stringBatchIds } },
        }),
      ]);

    // 4. In-Memory Mapping: Associate records with their parent batch
    const batchesData = activeBatches.map((batch) => {
      const historyPoints = [];

      // Add Farm Point
      if (batch.farmLocation) {
        historyPoints.push({
          eventType: "REGISTERED",
          latitude: batch.farmLocation.latitude,
          longitude: batch.farmLocation.longitude,
          timestamp: batch.createdAt,
          metadata: {
            location: batch.farmLocation.location,
            stage: "Farm",
            temperature: batch.farmLocation.temperature,
            humidity: batch.farmLocation.humidity,
          },
        });
      }

      // Filter and add Processing Points
      const procRecords = allProcessing.filter((p) => p.batchId === batch.id);
      procRecords.forEach((p) => {
        historyPoints.push({
          eventType: "PROCESSING",
          latitude: p.latitude,
          longitude: p.longitude,
          timestamp: p.processingDate,
          metadata: { location: p.processingLocation, stage: "Processing" },
        });
      });

      // Filter and add Distribution Points
      const distRecords = allDistribution.filter(
        (d) => d.batchId === batch.batchId
      );
      distRecords.forEach((d) => {
        historyPoints.push({
          eventType: "DISTRIBUTION_ARRIVAL",
          latitude: d.warehouseLat,
          longitude: d.warehouseLng,
          timestamp: d.distributionDate,
          metadata: { location: d.warehouseLocation, stage: "Distribution" },
        });
      });

      // Filter and add Retail Points
      const retailRecords = allTransfers.filter(
        (t) => t.batchId === batch.batchId
      );
      retailRecords.forEach((t) => {
        if (t.latitude && t.longitude) {
          historyPoints.push({
            eventType: "RETAIL_READY",
            latitude: parseFloat(t.latitude),
            longitude: parseFloat(t.longitude),
            timestamp: t.transferDate,
            metadata: { location: t.transferLocation, stage: "Retail" },
          });
        }
      });

      // Sort history points chronologically for the map
      historyPoints.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      return {
        batchId: batch.batchId,
        status: batch.status,
        cropType: batch.cropType,
        productType: batch.productType,
        quantity: batch.quantity,
        historyPoints,
        activeRoutes: allRoutes.filter(
          (r) => r.batchId === batch.id || r.batchIdName === batch.batchId
        ),
      };
    });

    res.json({ success: true, count: batchesData.length, batchesData });
  } catch (error) {
    console.error("Optimized fetch error:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET /api/analytics/weather-quality-correlation
app.get(
  "/api/analytics/weather-quality-correlation",
  authenticate,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const userRole = req.user.role;

      let whereClause = {
        OR: [
          { moistureContent: { not: null } },
          { qualityGrade: { not: null } },
        ],
      };

      // 1. Apply Farmer ID filtering
      if (userRole === "FARMER") {
        const farmerProfile = await prisma.farmerProfile.findUnique({
          where: { userId: userId },
        });

        if (!farmerProfile) {
          return res
            .status(404)
            .json({ success: false, error: "Farmer profile not found" });
        }

        whereClause.farmerId = farmerProfile.id;
      }

      // 2. Fetch only batches belonging to that farmer
      const batches = await prisma.batch.findMany({
        where: whereClause,
        include: {
          farmLocation: true,
          processingRecords: {
            orderBy: { processingDate: "desc" },
          },
        },
      });

    const batchIds = batches.map((b) => b.id);
    const distributionRecords = await prisma.distributionRecord.findMany({
      where: { batchIDHash: { in: batchIds } },
    });

    const processingRecords = await prisma.processingRecord.findMany({
      where: { batchId: { in: batchIds } },
    });

    const moistureContentEMC = (temp, humidity) => {
      if (temp == null || humidity == null) return null;

      const H = humidity / 100;

      const W = 330 + 0.452 * temp + 0.00415 * temp * temp;
      const K = 0.791 + 0.000463 * temp - 0.000000844 * temp * temp;
      const K1 = 6.34 + 0.000775 * temp - 0.0000935 * temp * temp;
      const K2 = 1.09 + 0.0284 * temp - 0.0000904 * temp * temp;

      const term1 = (K * H) / (1 - K * H);
      const term2 =
        (K1 * K * H + 2 * K1 * K2 * K * K * H * H) /
        (1 + K1 * K * H + K1 * K2 * K * K * H * H);

      const emc = (1800 / W) * (term1 + term2);

      return Number(emc.toFixed(2)); // % moisture
    };

      const correlationData = [];
      batches.forEach((batch) => {
        if (batch.farmLocation) {
          correlationData.push({
            batchId: batch.batchId,
            moisture: batch.moistureContent || 0,
            quality: batch.qualityGrade || "N/A",
            stage: "farm",
            temp: batch.farmLocation.temperature,
            humidity: batch.farmLocation.humidity,
            weather_main: batch.farmLocation.weather_main,
          });
        }
        batch.processingRecords.forEach((p) => {
          correlationData.push({
            batchId: batch.batchId,
            moisture:
              moistureContentEMC(
                parseFloat(p.temperature),
                parseFloat(p.humidity)
              ) || 0,
            quality: p.qualityTests?.grade || "N/A",
            stage: "processing",
            temp: parseFloat(p.temperature) || null,
            humidity: parseFloat(p.humidity) || null,
            weatherImpact: p.weather_main || null,
          });
        });
      });
      const weatherImpact = await prisma.$queryRaw`
      SELECT 
        condition,
        COUNT(*) as "totalOccurrences",
        COUNT(*) FILTER (WHERE grade = 'A') as "gradeA",
        COUNT(*) FILTER (WHERE grade = 'B') as "gradeB",
        COUNT(*) FILTER (WHERE grade = 'C') as "gradeC"
      FROM (
        SELECT weather_main as condition, "qualityTests" ->> 'grade' as grade FROM processing_records WHERE weather_main IS NOT NULL
        UNION ALL
        SELECT metadata ->> 'weather_main' as condition,metadata ->> 'quality' as grade FROM batch_location_history WHERE metadata ->> 'weather_main' IS NOT NULL
      ) as combined_weather
      GROUP BY condition
      ORDER BY "totalOccurrences" DESC
    `;
      const serializedWeatherImpact = weatherImpact.map((item) => ({
        ...item,
        totalOccurrences: Number(item.totalOccurrences),
        gradeA: Number(item.gradeA),
        gradeB: Number(item.gradeB),
        gradeC: Number(item.gradeC),
      }));

    res.json({
      success: true,
      correlationData,
      weatherImpact: serializedWeatherImpact,
    });
  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to aggregate correlation data",
    });
  }
});

// ============================================
// PRICING ENDPOINTS
// ============================================

// Add pricing record (for PROCESSOR, DISTRIBUTOR, RETAILER)
app.post(
  "/api/pricing/add",
  authenticate,
  authorize(["PROCESSOR", "DISTRIBUTOR", "RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId, level, pricePerUnit, totalValue, breakdown, notes } =
        req.body;

      // Validate required fields
      if (!batchId || !level || !pricePerUnit || !totalValue) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: batchId, level, pricePerUnit, totalValue",
        });
      }

      // Validate level
      const validLevels = ["PROCESSOR", "DISTRIBUTOR", "RETAILER"];
      if (!validLevels.includes(level)) {
        return res.status(400).json({
          success: false,
          error: `Invalid level. Must be one of: ${validLevels.join(", ")}`,
        });
      }

      // Check if batch exists in database
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      // Prepare pricing data
      const pricingData = {
        level,
        pricePerUnit: parseFloat(pricePerUnit),
        totalValue: parseFloat(totalValue),
        breakdown: breakdown || {},
        notes: notes || "",
      };

      // Submit to blockchain (with retry for MVCC conflicts)
      const { gateway, contract } = await blockchainService.connectToNetwork();

      const result = await retryOnMVCCConflict(async () => {
        return await contract.submitTransaction(
          "addPricingRecord",
          batchId,
          JSON.stringify(pricingData)
        );
      });

      await gateway.disconnect();

      const pricingRecord = JSON.parse(result.toString());

      res.json({
        success: true,
        pricing: pricingRecord,
        message: `Pricing record added successfully for ${level}`,
      });
    } catch (error) {
      console.error("Add pricing record error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add pricing record",
        details: error.message,
      });
    }
  }
);

// Get pricing history for a batch (public endpoint)
app.get("/api/pricing/history/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    // Check if batch exists and get farm-gate price
    const batch = await prisma.batch.findUnique({
      where: { batchId: batchId },
      include: {
        farmer: {
          include: {
            user: { select: { username: true } },
          },
        },
      },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    // Query blockchain for pricing history
    const { gateway, contract } = await blockchainService.connectToNetwork();

    const result = await contract.evaluateTransaction(
      "getPricingHistory",
      batchId
    );

    await gateway.disconnect();

    const pricingHistory = JSON.parse(result.toString());

    // Add farmer's farm-gate price as the first entry in pricing history (FT-01)
    if (batch.pricePerUnit) {
      const farmerPriceRecord = {
        level: "FARMER",
        pricePerUnit: parseFloat(batch.pricePerUnit),
        totalValue:
          parseFloat(batch.totalBatchValue) ||
          parseFloat(batch.pricePerUnit) * batch.quantity,
        currency: batch.currency || "MYR",
        unit: batch.unit || "kg",
        quantity: batch.quantity,
        timestamp: Math.floor(
          new Date(batch.createdAt).getTime() / 1000
        ).toString(),
        recordedBy: batch.farmer?.user?.username || "Farmer",
        notes: "Farm-gate price at harvest",
        breakdown: {},
      };

      // Prepend farmer's price to the pricing history
      if (pricingHistory.pricingHistory) {
        pricingHistory.pricingHistory = [
          farmerPriceRecord,
          ...pricingHistory.pricingHistory,
        ];
      } else {
        pricingHistory.pricingHistory = [farmerPriceRecord];
      }

      // Update total levels count
      pricingHistory.totalLevels = pricingHistory.pricingHistory.length;

      // If no current price set, use farmer's price
      if (!pricingHistory.currentPrice) {
        pricingHistory.currentPrice = {
          level: "FARMER",
          pricePerUnit: parseFloat(batch.pricePerUnit),
          totalValue:
            parseFloat(batch.totalBatchValue) ||
            parseFloat(batch.pricePerUnit) * batch.quantity,
          currency: batch.currency || "MYR",
        };
      }
    }

    res.json({
      success: true,
      data: pricingHistory,
    });
  } catch (error) {
    console.error("Get pricing history error:", error);

    // If chaincode returns error about no pricing records, still return farmer's price
    if (error.message.includes("No pricing records found")) {
      // Get batch for farmer's price
      const batch = await prisma.batch.findUnique({
        where: { batchId: req.params.batchId },
        include: {
          farmer: {
            include: {
              user: { select: { username: true } },
            },
          },
        },
      });

      const responseData = {
        batchId: req.params.batchId,
        currentPrice: null,
        pricingHistory: [],
        priceIncrease: null,
        totalLevels: 0,
      };

      // Include farmer's price if available
      if (batch?.pricePerUnit) {
        const farmerPriceRecord = {
          level: "FARMER",
          pricePerUnit: parseFloat(batch.pricePerUnit),
          totalValue:
            parseFloat(batch.totalBatchValue) ||
            parseFloat(batch.pricePerUnit) * batch.quantity,
          currency: batch.currency || "MYR",
          unit: batch.unit || "kg",
          quantity: batch.quantity,
          timestamp: Math.floor(
            new Date(batch.createdAt).getTime() / 1000
          ).toString(),
          recordedBy: batch.farmer?.user?.username || "Farmer",
          notes: "Farm-gate price at harvest",
          breakdown: {},
        };

        responseData.pricingHistory = [farmerPriceRecord];
        responseData.totalLevels = 1;
        responseData.currentPrice = {
          level: "FARMER",
          pricePerUnit: parseFloat(batch.pricePerUnit),
          totalValue:
            parseFloat(batch.totalBatchValue) ||
            parseFloat(batch.pricePerUnit) * batch.quantity,
          currency: batch.currency || "MYR",
        };
      }

      return res.json({
        success: true,
        data: responseData,
      });
    }

    res.status(500).json({
      success: false,
      error: "Failed to get pricing history",
      details: error.message,
    });
  }
});

// Get price markup calculation for a batch (public endpoint)
app.get("/api/pricing/markup/:batchId", async (req, res) => {
  try {
    const { batchId } = req.params;

    // Check if batch exists and get farm-gate price for markup baseline
    const batch = await prisma.batch.findUnique({
      where: { batchId: batchId },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    const farmerPrice = batch.pricePerUnit
      ? parseFloat(batch.pricePerUnit)
      : null;

    // Query blockchain for markup calculation
    const { gateway, contract } = await blockchainService.connectToNetwork();

    const result = await contract.evaluateTransaction(
      "calculatePriceMarkup",
      batchId
    );

    await gateway.disconnect();

    const markupData = JSON.parse(result.toString());

    // If we have farmer's price, add FARMER → first level markup (FT-05)
    if (farmerPrice && markupData.markups && markupData.markups.length > 0) {
      const firstLevelPrice =
        markupData.markups[0]?.previousPrice ||
        markupData.markups[0]?.currentPrice;

      // Check if first markup is already from FARMER
      if (markupData.markups[0]?.fromLevel !== "FARMER" && firstLevelPrice) {
        const farmerToFirstMarkup = firstLevelPrice - farmerPrice;
        const farmerToFirstPercentage = (
          (farmerToFirstMarkup / farmerPrice) *
          100
        ).toFixed(2);

        const farmerMarkupEntry = {
          fromLevel: "FARMER",
          toLevel: markupData.markups[0]?.fromLevel || "PROCESSOR",
          previousPrice: farmerPrice,
          currentPrice: firstLevelPrice,
          markup: farmerToFirstMarkup,
          markupPercentage: farmerToFirstPercentage,
        };

        // Prepend farmer markup
        markupData.markups = [farmerMarkupEntry, ...markupData.markups];

        // Recalculate totals
        const totalMarkup = markupData.markups.reduce(
          (sum, m) => sum + (m.markup || 0),
          0
        );
        const avgPercentage =
          markupData.markups.length > 0
            ? (
                markupData.markups.reduce(
                  (sum, m) => sum + parseFloat(m.markupPercentage || 0),
                  0
                ) / markupData.markups.length
              ).toFixed(2)
            : "0.00";

        markupData.totalMarkup = totalMarkup;
        markupData.averageMarkupPercentage = avgPercentage;
      }
    } else if (
      farmerPrice &&
      (!markupData.markups || markupData.markups.length === 0)
    ) {
      // No blockchain markups but we have farmer price - initialize empty structure
      markupData.markups = [];
      markupData.totalMarkup = 0;
      markupData.averageMarkupPercentage = "0.00";
    }

    res.json({
      success: true,
      data: markupData,
    });
  } catch (error) {
    console.error("Get price markup error:", error);

    // If chaincode returns error about insufficient pricing records
    if (error.message.includes("at least 2 pricing records")) {
      // Get batch to check for farmer price and any other pricing
      const batch = await prisma.batch.findUnique({
        where: { batchId: req.params.batchId },
      });

      const responseData = {
        batchId: req.params.batchId,
        markups: [],
        totalMarkup: 0,
        averageMarkupPercentage: "0.00",
      };

      // If we have farmer price and at least one pricing record, try to calculate markup
      if (batch?.pricePerUnit) {
        // Check if there's any pricing record in blockchain by querying pricing history
        try {
          const { gateway: gw, contract: ct } =
            await blockchainService.connectToNetwork();
          const pricingResult = await ct.evaluateTransaction(
            "getPricingHistory",
            req.params.batchId
          );
          await gw.disconnect();

          const pricingHistory = JSON.parse(pricingResult.toString());

          if (
            pricingHistory.pricingHistory &&
            pricingHistory.pricingHistory.length > 0
          ) {
            const farmerPrice = parseFloat(batch.pricePerUnit);
            const firstRecord = pricingHistory.pricingHistory[0];
            const firstPrice = firstRecord.pricePerUnit;

            const markup = firstPrice - farmerPrice;
            const markupPercentage = ((markup / farmerPrice) * 100).toFixed(2);

            responseData.markups = [
              {
                fromLevel: "FARMER",
                toLevel: firstRecord.level,
                previousPrice: farmerPrice,
                currentPrice: firstPrice,
                markup: markup,
                markupPercentage: markupPercentage,
              },
            ];
            responseData.totalMarkup = markup;
            responseData.averageMarkupPercentage = markupPercentage;
          }
        } catch (innerError) {
          // Ignore - just return empty markups
          console.log("No pricing records found for markup calculation");
        }
      }

      return res.json({
        success: true,
        data: responseData,
      });
    }

    res.status(500).json({
      success: false,
      error: "Failed to calculate price markup",
      details: error.message,
    });
  }
});

// ===== BATCH TRANSFER & OWNERSHIP ENDPOINTS =====

// Transfer batch ownership between supply chain actors
app.post(
  "/api/batch/transfer",
  authenticate,
  authorize(["FARMER", "PROCESSOR", "DISTRIBUTOR", "RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const {
        batchId,
        toActorId,
        toActorRole,
        transferLocation,
        latitude,
        longitude,
        notes,
        conditions,
        documents,
        signature,
      } = req.body;

      // Validation
      if (!batchId || !toActorId || !toActorRole) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: batchId, toActorId, toActorRole",
        });
      }

      // Validate role
      const validRoles = ["FARMER", "PROCESSOR", "DISTRIBUTOR", "RETAILER"];
      if (!validRoles.includes(toActorRole)) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid toActorRole. Must be FARMER, PROCESSOR, DISTRIBUTOR, or RETAILER",
        });
      }

      // Get batch to verify ownership
      const { gateway, contract } = await blockchainService.connectToNetwork();

      const batchResult = await contract.evaluateTransaction(
        "getBatch",
        batchId
      );
      const batch = JSON.parse(batchResult.toString());

      // Current actor info
      const fromActorId = req.user.id;
      const fromActorRole = req.user.role;

      // Prepare transfer data
      const transferData = {
        transferLocation: transferLocation || null,
        latitude: latitude || null,
        longitude: longitude || null,
        notes: notes || "",
        conditions: conditions || null,
        documents: documents || [],
        signature: signature || null,
      };

      // Call blockchain transferBatch function
      const timestamp = new Date().toISOString();
      const result = await contract.submitTransaction(
        "transferBatch",
        batchId,
        fromActorId,
        fromActorRole,
        toActorId,
        toActorRole,
        JSON.stringify(transferData)
      );

      const transferRecord = JSON.parse(result.toString());

      // ========== HASH OWNERSHIP TRANSFER DATA FOR INTEGRITY ==========
      // Prepare critical ownership transfer data for cryptographic hashing
      const ownershipDataForHash = {
        batchId: batchId, // Use string batchId
        fromActorId: fromActorId,
        fromActorRole: fromActorRole,
        toActorId: toActorId,
        toActorRole: toActorRole,
        transferType: "OWNERSHIP_TRANSFER",
        transferLocation: transferLocation || null,
        latitude: latitude || null,
        longitude: longitude || null,
        signature: signature || null,
        statusBefore: batch.status || "REGISTERED",
        statusAfter: transferRecord.statusAfter || batch.status,
        timestamp: new Date().toISOString(),
      };

      // Generate SHA-256 hash for data integrity verification
      const ownershipHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(ownershipDataForHash))
        .digest("hex");
      // ========== END HASH CALCULATION ==========

      // Store in database
      const dbTransfer = await prisma.batchTransfer.create({
        data: {
          batchId: batchId,
          fromActorId: fromActorId,
          fromActorRole: fromActorRole,
          toActorId: toActorId,
          toActorRole: toActorRole,
          transferType: "OWNERSHIP_TRANSFER",
          transferLocation: transferLocation || null,
          latitude: latitude || null,
          longitude: longitude || null,
          conditions: conditions ? conditions : null,
          documents: documents || [],
          signature: signature || null,
          notes: notes || "",
          status: "COMPLETED",
          statusBefore: batch.status || "REGISTERED",
          statusAfter: transferRecord.statusAfter || batch.status,
          blockchainTxId: transferRecord.txId || null,
          blockchainHash: ownershipHash, // ← INTEGRITY HASH
        },
      });

      // Update batch status in database if it exists
      const dbBatch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (dbBatch) {
        await prisma.batch.update({
          where: { batchId: batchId },
          data: {
            status: transferRecord.statusAfter || dbBatch.status,
          },
        });
      }

      await gateway.disconnect();

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "TRANSFER_BATCH",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            fromRole: fromActorRole,
            toActorId: toActorId,
            toRole: toActorRole,
            transferId: dbTransfer.id,
          },
        },
      });

      res.json({
        success: true,
        message: `Batch ${batchId} successfully transferred to ${toActorRole}`,
        data: {
          blockchainRecord: transferRecord,
          databaseRecord: dbTransfer,
        },
      });
    } catch (error) {
      console.error("Batch transfer error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to transfer batch",
        details: error.message,
      });
    }
  }
);

// Add transport/logistics record
app.post(
  "/api/transport/add",
  authenticate,
  authorize(["DISTRIBUTOR", "PROCESSOR", "ADMIN"]),
  async (req, res) => {
    try {
      const {
        batchId,
        origin,
        originCoordinates,
        destination,
        destinationCoordinates,
        carrier,
        vehicleType,
        vehicleId,
        driverName,
        departureTime,
        estimatedArrival,
        transportCost,
        currency,
        fuelCost,
        tollFees,
        waybillNumber,
        notes,
        updateStatus,
      } = req.body;

      const batch = await prisma.batch.findUnique({
        where: { batchId: id },
      });

      // Validation
      if (!batchId) {
        return res.status(400).json({
          success: false,
          error: "batchId is required",
        });
      }

      // Prepare transport data
      const transportData = {
        origin: origin || null,
        originCoordinates: originCoordinates || null,
        destination: destination || null,
        destinationCoordinates: destinationCoordinates || null,
        carrier: carrier || null,
        vehicleType: vehicleType || null,
        vehicleId: vehicleId || null,
        driverName: driverName || null,
        departureTime: departureTime || null,
        estimatedArrival: estimatedArrival || null,
        transportCost: transportCost || null,
        currency: currency || "MYR",
        fuelCost: fuelCost || null,
        tollFees: tollFees || null,
        waybillNumber: waybillNumber || null,
        notes: notes || "",
        updateStatus: updateStatus || false,
      };

      // Call blockchain addTransportRecord function
      const { gateway, contract } = await blockchainService.connectToNetwork();

      const result = await contract.submitTransaction(
        "addTransportRecord",
        batchId,
        JSON.stringify(transportData)
      );

      const transportRecord = JSON.parse(result.toString());

      // ========== HASH TRANSPORT DATA FOR INTEGRITY ==========
      // Prepare critical transport data for cryptographic hashing
      const transportDataForHash = {
        batchId: batchId, // Use string batchId
        origin: origin || null,
        destination: destination || null,
        carrier: carrier || null,
        vehicleType: vehicleType || null,
        vehicleId: vehicleId || null,
        driverName: driverName || null,
        departureTime: departureTime || null,
        estimatedArrival: estimatedArrival || null,
        transportCost: transportCost ? parseFloat(transportCost) : null,
        currency: currency || "MYR",
        fuelCost: fuelCost ? parseFloat(fuelCost) : null,
        tollFees: tollFees ? parseFloat(tollFees) : null,
        waybillNumber: waybillNumber || null,
        originLat: originCoordinates?.latitude || null,
        originLng: originCoordinates?.longitude || null,
        destinationLat: destinationCoordinates?.latitude || null,
        destinationLng: destinationCoordinates?.longitude || null,
        timestamp: new Date().toISOString(),
      };

      // Generate SHA-256 hash for data integrity verification
      const transportHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(transportDataForHash))
        .digest("hex");
      // ========== END HASH CALCULATION ==========

      // Store in database (TransportRoute table)
      const dbTransport = await prisma.transportRoute.create({
        data: {
          batchId: batch.id,
          distributorId: req.user.id,
          vehicleId: vehicleId || null,
          originLat: originCoordinates?.latitude || 0,
          originLng: originCoordinates?.longitude || 0,
          destinationLat: destinationCoordinates?.latitude || 0,
          destinationLng: destinationCoordinates?.longitude || 0,
          departureTime: departureTime ? new Date(departureTime) : null,
          estimatedTime: estimatedArrival ? new Date(estimatedArrival) : null,
          transportCost: transportCost ? parseFloat(transportCost) : null,
          status: updateStatus ? "IN_TRANSIT" : "PLANNED",
          blockchainHash: transportHash, // ← INTEGRITY HASH (changed from txId)
        },
      });

      await gateway.disconnect();

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADD_TRANSPORT_RECORD",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            transportId: transportRecord.transportId,
            origin: origin,
            destination: destination,
          },
        },
      });

      res.json({
        success: true,
        message: "Transport record added successfully",
        data: {
          blockchainRecord: transportRecord,
          databaseRecord: dbTransport,
        },
      });
    } catch (error) {
      console.error("Add transport record error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add transport record",
        details: error.message,
      });
    }
  }
);

// Get transport history for a batch
app.get("/api/transport/:batchId", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Get from blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();

    const result = await contract.evaluateTransaction(
      "getTransportHistory",
      batchId
    );

    const transportHistory = JSON.parse(result.toString());

    // Get from database
    const dbTransports = await prisma.transportRoute.findMany({
      where: { batchId: batchId },
      orderBy: { departureTime: "desc" },
    });

    // Get batch transfers from database
    const dbTransfers = await prisma.batchTransfer.findMany({
      where: { batchId: batchId },
      orderBy: { createdAt: "desc" },
    });

    await gateway.disconnect();

    res.json({
      success: true,
      data: {
        blockchain: transportHistory,
        database: {
          transportRecords: dbTransports,
          batchTransfers: dbTransfers,
        },
      },
    });
  } catch (error) {
    console.error("Get transport history error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get transport history",
      details: error.message,
    });
  }
});

// Get ownership history for a batch
app.get("/api/ownership/:batchId", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Get from blockchain
    const { gateway, contract } = await blockchainService.connectToNetwork();

    const result = await contract.evaluateTransaction(
      "getOwnershipHistory",
      batchId
    );

    const ownershipHistory = JSON.parse(result.toString());

    // Get from database
    const dbTransfers = await prisma.batchTransfer.findMany({
      where: { batchId: batchId },
      orderBy: { createdAt: "asc" },
    });

    await gateway.disconnect();

    res.json({
      success: true,
      data: {
        blockchain: ownershipHistory,
        database: dbTransfers,
      },
    });
  } catch (error) {
    console.error("Get ownership history error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get ownership history",
      details: error.message,
    });
  }
});

// ===== QUALITY TEST ENDPOINTS =====

// Add a quality test to a batch
app.post(
  "/api/quality-test/:batchId",
  authenticate,
  authorize(["PROCESSOR", "REGULATOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        testType,
        testDate,
        testingLab,
        testResults,
        passFailStatus,
        certificateUrl,
      } = req.body;

      // Validate required fields
      if (!testType || !testingLab || !passFailStatus) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: testType, testingLab, passFailStatus",
        });
      }

      // Find the batch by batchId string
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      // Prepare quality test data for integrity hash
      const qualityData = {
        testType,
        testDate: testDate || new Date().toISOString(),
        testingLab,
        testResults: testResults || {},
        passFailStatus,
        certificateUrl: certificateUrl || null,
        testedBy: req.user.username,
        testedByRole: req.user.role,
        batchId: batchId,
        timestamp: new Date().toISOString(),
      };

      // Generate SHA-256 hash for data integrity verification
      // This hash can be used to verify the quality test data hasn't been tampered with
      const crypto = require("crypto");
      const dataHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(qualityData))
        .digest("hex");

      // Create the quality test record in database
      const qualityTest = await prisma.qualityTest.create({
        data: {
          batchId: batch.id,
          testType,
          testDate: testDate ? new Date(testDate) : new Date(),
          testingLab,
          testResults: testResults || {},
          passFailStatus,
          certificateUrl: certificateUrl || null,
          blockchainHash: dataHash, // Store integrity hash
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADD_QUALITY_TEST",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            testId: qualityTest.id,
            testType,
            passFailStatus,
            integrityHash: dataHash,
          },
        },
      });

      res.status(201).json({
        success: true,
        message: "Quality test added successfully",
        data: qualityTest,
        integrityHash: dataHash,
      });
    } catch (error) {
      console.error("Add quality test error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add quality test",
        details: error.message,
      });
    }
  }
);

// Get quality tests for a batch
app.get("/api/quality-tests/:batchId", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Find the batch by batchId string
    const batch = await prisma.batch.findUnique({
      where: { batchId: batchId },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    const qualityTests = await prisma.qualityTest.findMany({
      where: { batchId: batch.id },
      orderBy: { testDate: "desc" },
    });

    res.json({
      success: true,
      data: qualityTests,
      count: qualityTests.length,
    });
  } catch (error) {
    console.error("Get quality tests error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get quality tests",
      details: error.message,
    });
  }
});

// ===== TRANSPORT ROUTE ENDPOINTS =====

// Add a transport route manually
app.post(
  "/api/transport-route/:batchId",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        vehicleId,
        originLat,
        originLng,
        destinationLat,
        destinationLng,
        departureTime,
        arrivalTime,
        estimatedTime,
        distance,
        fuelConsumption,
        transportCost,
        status,
      } = req.body;

      // Validate required fields
      if (!originLat || !originLng || !destinationLat || !destinationLng) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required coordinates: originLat, originLng, destinationLat, destinationLng",
        });
      }

      // Find the batch by batchId string
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      // Get distributor profile
      const distributorProfile = await prisma.distributorProfile.findUnique({
        where: { userId: req.user.id },
      });

      if (!distributorProfile) {
        return res.status(400).json({
          success: false,
          error: "Distributor profile not found",
        });
      }

      // Prepare blockchain transport data
      const blockchainTransportData = {
        transportId: `TRANS${Date.now()}`,
        origin: `${originLat}, ${originLng}`,
        originCoordinates: {
          lat: parseFloat(originLat),
          lng: parseFloat(originLng),
        },
        destination: `${destinationLat}, ${destinationLng}`,
        destinationCoordinates: {
          lat: parseFloat(destinationLat),
          lng: parseFloat(destinationLng),
        },
        vehicleId: vehicleId || null,
        departureTime: departureTime || null,
        estimatedArrival: arrivalTime || null,
        transportCost: transportCost ? parseFloat(transportCost) : null,
        fuelCost: fuelConsumption ? parseFloat(fuelConsumption) : null,
        currency: "MYR",
        carrier: distributorProfile.companyName || req.user.username,
        currentStatus: status || "PLANNED",
        updateStatus: false, // Don't change batch status
      };

      // Record on blockchain
      let blockchainTxId = null;
      try {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();
        const result = await contract.submitTransaction(
          "addTransportRecord",
          batchId,
          JSON.stringify(blockchainTransportData)
        );
        const blockchainResult = JSON.parse(result.toString());
        blockchainTxId = blockchainResult.txId;
        await gateway.disconnect();
      } catch (blockchainError) {
        console.warn(
          "Blockchain recording failed (continuing with database):",
          blockchainError.message
        );
      }

      // Create the transport route record in database
      const transportRoute = await prisma.transportRoute.create({
        data: {
          batchId: batch.id,
          distributorId: distributorProfile.id,
          vehicleId: vehicleId || null,
          originLat: parseFloat(originLat),
          originLng: parseFloat(originLng),
          destinationLat: parseFloat(destinationLat),
          destinationLng: parseFloat(destinationLng),
          departureTime: departureTime ? new Date(departureTime) : null,
          arrivalTime: arrivalTime ? new Date(arrivalTime) : null,
          estimatedTime: estimatedTime ? parseInt(estimatedTime) : 0,
          distance: distance ? parseFloat(distance) : null,
          fuelConsumption: fuelConsumption ? parseFloat(fuelConsumption) : null,
          transportCost: transportCost ? parseFloat(transportCost) : null,
          status: status || "PLANNED",
          blockchainHash: blockchainTxId,
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADD_TRANSPORT_ROUTE",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            routeId: transportRoute.id,
            vehicleId,
            status: status || "PLANNED",
            blockchainTxId,
          },
        },
      });

      res.status(201).json({
        success: true,
        message: "Transport route added successfully",
        data: transportRoute,
        blockchainTxId,
      });
    } catch (error) {
      console.error("Add transport route error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add transport route",
        details: error.message,
      });
    }
  }
);

// Get transport routes for a batch
app.get("/api/transport-routes/:batchId", authenticate, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Find the batch by batchId string
    const batch = await prisma.batch.findUnique({
      where: { batchId: batchId },
    });

    if (!batch) {
      return res.status(404).json({
        success: false,
        error: "Batch not found",
      });
    }

    const transportRoutes = await prisma.transportRoute.findMany({
      where: { batchId: batch.id },
      include: {
        distributor: {
          select: {
            companyName: true,
            contactPerson: true,
          },
        },
      },
      orderBy: { departureTime: "desc" },
    });

    res.json({
      success: true,
      data: transportRoutes,
      count: transportRoutes.length,
    });
  } catch (error) {
    console.error("Get transport routes error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get transport routes",
      details: error.message,
    });
  }
});

// ===== DISTRIBUTOR ENDPOINTS =====

// Get batches available for distribution (PROCESSED status)
app.get(
  "/api/distributor/available-batches",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { gateway, contract } = await blockchainService.connectToNetwork();

      const result = await contract.evaluateTransaction(
        "getAvailableBatchesForDistributor"
      );
      const availableBatches = JSON.parse(result.toString());

      await gateway.disconnect();

      res.json({
        success: true,
        data: availableBatches,
        count: availableBatches.length,
      });
    } catch (error) {
      console.error("Get available batches for distributor error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to get available batches",
        details: error.message,
      });
    }
  }
);

// Receive batch from processor (transfer ownership) - BLOCKCHAIN + DATABASE
app.post(
  "/api/distributor/receive/:batchId",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        fromProcessorId,
        transferLocation,
        latitude,
        longitude,
        notes,
        conditions,
        documents,
        signature,
      } = req.body;

      const distributorId = req.user.id;
      console.log("🚛 Receive batch - User:", {
        id: distributorId,
        email: req.user.email,
        role: req.user.role,
      });

      const { gateway, contract } = await blockchainService.connectToNetwork();

      // Get batch to determine current owner
      console.log("📦 Fetching batch from blockchain:", batchId);
      const batchResult = await contract.evaluateTransaction(
        "getBatch",
        batchId
      );
      const batch = JSON.parse(batchResult.toString());
      console.log("✅ Batch current owner:", batch.currentOwner);

      // Determine fromActorId
      let fromActorId = batch.currentOwner?.actorId || fromProcessorId;
      let fromActorRole = batch.currentOwner?.actorRole || "PROCESSOR";

      // If currentOwner is not set, try to get from processing records or farmer
      if (!fromActorId) {
        if (batch.processingRecords && batch.processingRecords.length > 0) {
          // Get the last processor
          const lastProcessing =
            batch.processingRecords[batch.processingRecords.length - 1];
          fromActorId = lastProcessing.processorId;
          fromActorRole = "PROCESSOR";
          console.log("⚠️ No currentOwner, using last processor:", fromActorId);
        } else {
          // Fallback to farmer
          fromActorId = batch.farmer;
          fromActorRole = "FARMER";
          console.log(
            "⚠️ No currentOwner or processor, using farmer:",
            fromActorId
          );
        }
      }

      const transferData = {
        transferLocation: transferLocation || null,
        latitude: latitude || null,
        longitude: longitude || null,
        notes: notes || "Batch received by distributor",
        conditions: conditions || null,
        documents: documents || [],
        signature: signature || null,
      };

      // Convert fromActorId from username to user ID if needed (blockchain stores username)
      let fromActorDbId = fromActorId;
      if (fromActorId && !fromActorId.startsWith("cm")) {
        // Looks like a username, not a cuid - look up the user
        const fromUser = await prisma.user.findUnique({
          where: { username: fromActorId },
          select: { id: true },
        });
        if (fromUser) {
          fromActorDbId = fromUser.id;
          console.log(
            `🔄 Converted username "${fromActorId}" to user ID "${fromActorDbId}"`
          );
        }
      }

      console.log("🔄 Transfer params:", {
        batchId,
        fromActorId: fromActorDbId,
        fromActorRole,
        toActorId: distributorId,
        toActorRole: "DISTRIBUTOR",
      });

      // BLOCKCHAIN: Transfer batch
      const result = await contract.submitTransaction(
        "transferBatch",
        batchId,
        fromActorId,
        fromActorRole,
        distributorId,
        "DISTRIBUTOR",
        JSON.stringify(transferData)
      );
      const transferRecord = JSON.parse(result.toString());

      // DATABASE: Store transfer record (use fromActorDbId which is the actual user ID)
      const dbTransfer = await prisma.batchTransfer.create({
        data: {
          batchId: batchId,
          fromActorId: fromActorDbId,
          fromActorRole: fromActorRole,
          toActorId: distributorId,
          toActorRole: "DISTRIBUTOR",
          transferType: "OWNERSHIP_TRANSFER",
          transferLocation: transferLocation || null,
          latitude: latitude || null,
          longitude: longitude || null,
          conditions: conditions ? conditions : null,
          documents: documents || [],
          signature: signature || null,
          notes: notes || "Batch received by distributor",
          status: "COMPLETED",
          statusBefore: batch.status || "PROCESSED",
          statusAfter: "IN_DISTRIBUTION",
          blockchainTxId: transferRecord.txId || null,
          blockchainHash: null,
        },
      });

      // Update batch status in database if exists
      const dbBatch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        // include: { processingRecords: true },
      });
      if (dbBatch) {
        await prisma.batch.update({
          where: { batchId: batchId },
          data: { status: "IN_DISTRIBUTION" },
        });
      }

      // if (dbBatch.processingRecords && latitude && longitude) {
      //   const routeData = await getORSRoute(
      //     {
      //       lat: dbBatch.processingRecords.latitude,
      //       lng: dbBatch.processingRecords.longitude,
      //     },
      //     { lat: parseFloat(latitude), lng: parseFloat(longitude) }
      //   );

      //   if (routeData) {
      //     await prisma.transportRoute.create({
      //       data: {
      //         batchId: batchId,
      //         distributorId: req.user.id,
      //         originLat: dbBatch.processingRecords.latitude,
      //         originLng: dbBatch.processingRecords.longitude,
      //         destinationLat: parseFloat(latitude),
      //         destinationLng: parseFloat(longitude),
      //         estimatedTime: routeData.durationMinutes,
      //         distance: routeData.distanceKm,
      //         routePolyline: routeData.geometry,
      //         status: "IN_TRANSIT",
      //       },
      //     });
      //   }
      // }
      await gateway.disconnect();

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "RECEIVE_BATCH",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            fromActorId: fromActorId,
            fromRole: fromActorRole,
            transferId: dbTransfer.id,
          },
        },
      });

      res.json({
        success: true,
        message: `Batch ${batchId} successfully received by distributor`,
        data: { blockchainRecord: transferRecord, databaseRecord: dbTransfer },
      });
    } catch (error) {
      console.error("❌ Receive batch error:", error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        endorsements: error.endorsements,
        responses: error.responses,
      });
      res.status(500).json({
        success: false,
        error: "Failed to receive batch",
        details: error.message,
        hint: "Check backend logs for detailed error information",
      });
    }
  }
);

// Get batches owned by current distributor
app.get(
  "/api/distributor/my-batches",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    let gateway = null;
    try {
      const distributorId = req.user.id;
      let blockchainBatches = [];

      // Try blockchain first
      try {
        const connection = await blockchainService.connectToNetwork();
        gateway = connection.gateway;
        const contract = connection.contract;

        const result = await contract.evaluateTransaction(
          "getBatchesByDistributor",
          distributorId
        );
        blockchainBatches = JSON.parse(result.toString());
      } catch (bcError) {
        console.warn(
          "Blockchain query failed, using database fallback:",
          bcError.message
        );
      }

      // Also get batches from database where distributor has received them
      // This catches split batches and ensures consistency
      const dbTransfers = await prisma.batchTransfer.findMany({
        where: {
          toActorId: distributorId,
          toActorRole: "DISTRIBUTOR",
          status: "COMPLETED",
        },
        select: { batchId: true },
      });

      // Get unique batch IDs from transfers
      const transferredBatchIds = [
        ...new Set(dbTransfers.map((t) => t.batchId)),
      ];

      // Get batches from database that were transferred to this distributor
      const dbBatches = await prisma.batch.findMany({
        where: {
          batchId: { in: transferredBatchIds },
          status: { notIn: ["SOLD", "RECALLED"] },
        },
        include: {
          farmer: {
            select: { firstName: true, lastName: true, farmName: true },
          },
          farmLocation: {
            select: { latitude: true, longitude: true, location: true },
          },
          childBatches: {
            select: {
              batchId: true,
              quantity: true,
              splitReason: true,
              status: true,
            },
          },
        },
      });

      // Get the internal IDs of transferred batches
      const dbBatchInternalIds = dbBatches.map((b) => b.id);

      // Also get split batches - children of batches this distributor owns
      const splitBatches = await prisma.batch.findMany({
        where: {
          parentBatchId: { in: dbBatchInternalIds },
          status: { notIn: ["SOLD", "RECALLED"] },
        },
        include: {
          farmer: {
            select: { firstName: true, lastName: true, farmName: true },
          },
          farmLocation: {
            select: { latitude: true, longitude: true, location: true },
          },
          parentBatch: {
            select: { batchId: true },
          },
        },
      });

      // All split batches from owned parents are valid
      const validSplitBatches = splitBatches;

      // Merge blockchain and database results, avoiding duplicates
      const addedBatchIds = new Set(blockchainBatches.map((b) => b.batchId));
      const combinedBatches = [...blockchainBatches];

      // Add database batches that aren't already added
      for (const dbBatch of [...dbBatches, ...validSplitBatches]) {
        if (!addedBatchIds.has(dbBatch.batchId)) {
          addedBatchIds.add(dbBatch.batchId); // Track this batch as added
          combinedBatches.push({
            batchId: dbBatch.batchId,
            crop: dbBatch.productType,
            productType: dbBatch.productType,
            variety: dbBatch.variety,
            quantity: dbBatch.quantity,
            unit: dbBatch.unit,
            status: dbBatch.status,
            harvestDate: dbBatch.harvestDate,
            qualityGrade: dbBatch.qualityGrade,
            pricePerUnit: dbBatch.pricePerUnit,
            currency: dbBatch.currency,
            totalBatchValue: dbBatch.totalBatchValue,
            certifications: dbBatch.certifications,
            parentBatchId: dbBatch.parentBatchId
              ? dbBatch.parentBatch?.batchId || dbBatch.parentBatchId
              : null,
            splitReason: dbBatch.splitReason,
            childBatches: dbBatch.childBatches || [],
            farmer: dbBatch.farmer
              ? `${dbBatch.farmer.firstName} ${dbBatch.farmer.lastName}`
              : null,
            farmName: dbBatch.farmer?.farmName,
            location: dbBatch.farmLocation?.location,
            coordinates: dbBatch.farmLocation
              ? {
                  latitude: dbBatch.farmLocation.latitude,
                  longitude: dbBatch.farmLocation.longitude,
                }
              : null,
            source: "database",
          });
        }
      }

      // Query for distribution records for all batches
      const allBatchIds = combinedBatches.map((b) => b.batchId);

      // Check which batches have distribution records
      const distributionRecords = await prisma.distributionRecord.findMany({
        where: { batchId: { in: allBatchIds } },
        select: { batchId: true },
      });
      const batchesWithDistribution = new Set(
        distributionRecords.map((r) => r.batchId)
      );

      // Note: Pricing records are stored on blockchain only and would require
      // individual queries per batch via getPricingHistory chaincode function.
      // For performance, we skip this check. Frontend can query individually if needed.

      // Add flags to each batch and filter to only IN_DISTRIBUTION status
      const enrichedBatches = combinedBatches
        .filter((batch) => batch.status === "IN_DISTRIBUTION")
        .map((batch) => ({
          ...batch,
          hasDistributionRecord: batchesWithDistribution.has(batch.batchId),
          // hasPricingRecord flag can be added by querying blockchain individually
          // For now, we don't check this to avoid performance issues
        }));

      // Disconnect gateway if connected
      if (gateway) {
        await gateway.disconnect();
      }

      res.json({
        success: true,
        data: enrichedBatches,
        count: enrichedBatches.length,
        blockchainCount: blockchainBatches.length,
        databaseCount: combinedBatches.length - blockchainBatches.length,
      });
    } catch (error) {
      console.error("Get distributor batches error:", error);
      if (gateway) {
        try {
          await gateway.disconnect();
        } catch (e) {}
      }
      res.status(500).json({
        success: false,
        error: "Failed to get distributor batches",
        details: error.message,
      });
    }
  }
);

// Add distribution record - BLOCKCHAIN + DATABASE
app.post(
  "/api/distributor/add-distribution/:batchId",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        distributionType,
        warehouseLocation,
        warehouseCoordinates,
        storageConditions,
        temperatureControl,
        vehicleType,
        vehicleId,
        driverName,
        route,
        quantityReceived,
        quantityDistributed,
        distributionCost,
        storageCost,
        handlingCost,
        currency,
        qualityCheckPassed,
        qualityNotes,
        documents,
        notes,
        destinationType,
        destination,
        weatherData,
      } = req.body;

      const distributorId = req.user.id;
      const temperature = weatherData?.temperature;
      const weather_desc = weatherData?.weather_description;
      const weather_main = weatherData?.weather_main;
      const humidity = weatherData?.humidity;
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        include: { processingRecords: true },
      });

      let latestProcessing = null;
      if (batch.parentBatchId) {
        const parentBatch = await prisma.batch.findUnique({
          where: { id: batch.parentBatchId },
          include: { processingRecords: true },
        });
        if (
          parentBatch &&
          parentBatch.processingRecords &&
          parentBatch.processingRecords.length > 0
        ) {
          latestProcessing =
            parentBatch.processingRecords[
              parentBatch.processingRecords.length - 1
            ];
        }
      } else {
        latestProcessing =
          batch.processingRecords[batch.processingRecords.length - 1];
      }

      const distributionData = {
        distributionType: distributionType || null,
        warehouseLocation: warehouseLocation || null,
        warehouseCoordinates: warehouseCoordinates || null,
        storageConditions: storageConditions || null,
        temperatureControl: temperatureControl || null,
        humidity: humidity || null,
        vehicleType: vehicleType || null,
        vehicleId: vehicleId || null,
        driverName: driverName || null,
        route: route || [],
        quantityReceived: quantityReceived || null,
        quantityDistributed: quantityDistributed || null,
        distributionCost: distributionCost || null,
        storageCost: storageCost || null,
        handlingCost: handlingCost || null,
        currency: currency || "MYR",
        qualityCheckPassed: qualityCheckPassed || null,
        qualityNotes: qualityNotes || "",
        documents: documents || [],
        notes: notes || "",
        destinationType: destinationType || null,
        destination: destination || null,
        temperature: temperature ? parseFloat(temperature) : null,
        weather_desc: weather_desc || null,
        weather_main: weather_main || null,
      };

      const { gateway, contract } = await blockchainService.connectToNetwork();

      // BLOCKCHAIN: Add distribution record (with retry for MVCC conflicts)
      const distributionRecord = await retryOnMVCCConflict(async () => {
        const result = await contract.submitTransaction(
          "addDistributionRecord",
          batchId,
          distributorId,
          JSON.stringify(distributionData)
        );
        return JSON.parse(result.toString());
      });

      // ========== HASH DISTRIBUTION DATA FOR INTEGRITY ==========
      // Prepare critical distribution data for cryptographic hashing
      const distributionDataForHash = {
        batchId: batchId, // Use string batchId
        distributorId: distributorId,
        distributionType: distributionType || null,
        warehouseLocation: warehouseLocation || null,
        warehouseLat: warehouseCoordinates?.latitude || null,
        warehouseLng: warehouseCoordinates?.longitude || null,
        storageConditions: storageConditions || null,
        temperatureControl: temperatureControl || null,
        humidity: humidity ? parseFloat(humidity) : null,
        quantityReceived: quantityReceived
          ? parseFloat(quantityReceived)
          : null,
        quantityDistributed: quantityDistributed
          ? parseFloat(quantityDistributed)
          : null,
        distributionCost: distributionCost
          ? parseFloat(distributionCost)
          : null,
        storageCost: storageCost ? parseFloat(storageCost) : null,
        handlingCost: handlingCost ? parseFloat(handlingCost) : null,
        currency: currency || "MYR",
        destinationType: destinationType || null,
        destination: destination || null,
        timestamp: new Date().toISOString(),
      };

      // Generate SHA-256 hash for data integrity verification
      const distributionHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(distributionDataForHash))
        .digest("hex");
      // ========== END HASH CALCULATION ==========

      // DATABASE: Store distribution record
      const dbDistribution = await prisma.distributionRecord.create({
        data: {
          batchId: batchId,
          batchIDHash: batch.id,
          distributorId: distributorId,
          distributionType: distributionType || null,
          warehouseLocation: warehouseLocation || null,
          warehouseLat: warehouseCoordinates?.latitude || null,
          warehouseLng: warehouseCoordinates?.longitude || null,
          storageConditions: storageConditions || null,
          temperatureControl: temperatureControl || null,
          humidity: humidity ? parseFloat(humidity) : null,
          vehicleType: vehicleType || null,
          vehicleId: vehicleId || null,
          driverName: driverName || null,
          route: route ? route : null,
          quantityReceived: quantityReceived
            ? parseFloat(quantityReceived)
            : null,
          quantityDistributed: quantityDistributed
            ? parseFloat(quantityDistributed)
            : null,
          distributionCost: distributionCost
            ? parseFloat(distributionCost)
            : null,
          storageCost: storageCost ? parseFloat(storageCost) : null,
          handlingCost: handlingCost ? parseFloat(handlingCost) : null,
          currency: currency || "MYR",
          qualityCheckPassed: qualityCheckPassed || null,
          qualityNotes: qualityNotes || null,
          documents: documents || [],
          notes: notes || null,
          destinationType: destinationType || null,
          destination: destination || null,
          blockchainTxId: distributionRecord.txId || null,
          blockchainHash: distributionHash, // ← INTEGRITY HASH
          temperature: temperature ? parseFloat(temperature) : null,
          weather_desc: weather_desc || null,
          weather_main: weather_main || null,
        },
      });

      // ========== ADD PRICING RECORD TO BLOCKCHAIN ==========
      // Calculate total cost and price per unit for distributor stage
      const totalCost =
        (distributionCost ? parseFloat(distributionCost) : 0) +
        (storageCost ? parseFloat(storageCost) : 0) +
        (handlingCost ? parseFloat(handlingCost) : 0);

      // Get previous price (from batch or calculate from costs)
      let distributorPricePerUnit = 0;
      let distributorTotalValue = 0;
      const quantity = parseFloat(quantityReceived || batch.quantity);

      if (totalCost > 0 && quantity > 0) {
        // Get the current batch price (what they paid to receive it)
        const currentBatchPrice = parseFloat(batch.pricePerUnit || 0);

        // Calculate new price = previous price + (total costs / quantity)
        distributorPricePerUnit = currentBatchPrice + totalCost / quantity;
        distributorTotalValue = distributorPricePerUnit * quantity;

        // Add pricing record to blockchain
        try {
          const pricingData = {
            level: "DISTRIBUTOR",
            pricePerUnit: distributorPricePerUnit,
            totalValue: distributorTotalValue,
            breakdown: {
              basePrice: currentBatchPrice,
              distributionCost: distributionCost
                ? parseFloat(distributionCost)
                : 0,
              storageCost: storageCost ? parseFloat(storageCost) : 0,
              handlingCost: handlingCost ? parseFloat(handlingCost) : 0,
            },
            notes: notes || "Distribution pricing",
          };

          await retryOnMVCCConflict(async () => {
            return await contract.submitTransaction(
              "addPricingRecord",
              batchId,
              JSON.stringify(pricingData)
            );
          });

          console.log(
            `💰 Pricing record added to blockchain for distributor - Price: MYR ${distributorPricePerUnit.toFixed(
              2
            )}/unit`
          );
        } catch (pricingError) {
          console.error(
            "⚠️ Failed to add pricing record to blockchain:",
            pricingError.message
          );
          // Don't fail the whole request if pricing fails
        }
      }
      // ========== END PRICING RECORD ==========

      const distributionTime = dbDistribution.distributionDate;
      const startTime = latestProcessing.processingDate.getTime();
      const endTime = dbDistribution.createdAt.getTime();

      const totalTimeCalc = Math.ceil((endTime - startTime) / 60000);

      if (
        batch.processingRecords &&
        warehouseCoordinates.latitude &&
        warehouseCoordinates.longitude
      ) {
        const routeData = await getORSRoute(
          {
            lat: latestProcessing.latitude,
            lng: latestProcessing.longitude,
          },
          {
            lat: parseFloat(warehouseCoordinates.latitude),
            lng: parseFloat(warehouseCoordinates.longitude),
          }
        );
        if (routeData) {
          await prisma.transportRoute.create({
            data: {
              batch: { connect: { id: batch.id } },
              batchIdName: batch.batchId,
              distributorId: req.user.id,
              originLat: latestProcessing.latitude,
              originLng: latestProcessing.longitude,
              destinationLat: parseFloat(warehouseCoordinates?.latitude),
              destinationLng: parseFloat(warehouseCoordinates?.longitude),
              estimatedTime: routeData.durationMinutes,
              // idea is the eta will be the diff between when the farmer registered it the crop and when the processor accepts it for processing
              TotalTime: totalTimeCalc,
              distance: parseFloat(routeData.distanceKm),
              timestamp: distributionTime,
              routePolyline: routeData.geometry,
              status: "IN_TRANSIT",
            },
          });
        }
      }

      await gateway.disconnect();

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "ADD_DISTRIBUTION_RECORD",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            distributionId: dbDistribution.id,
            distributionType: distributionType,
          },
        },
      });

      res.json({
        success: true,
        message: "Distribution record added successfully",
        data: {
          blockchainRecord: distributionRecord,
          databaseRecord: dbDistribution,
        },
      });
    } catch (error) {
      console.error("Add distribution record error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to add distribution record",
        details: error.message,
      });
    }
  }
);

// Transfer batch to retailer - BLOCKCHAIN + DATABASE
app.post(
  "/api/distributor/transfer-to-retailer/:batchId",
  authenticate,
  authorize(["DISTRIBUTOR", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const {
        toRetailerId,
        transferLocation,
        latitude,
        longitude,
        notes,
        conditions,
        documents,
        signature,
        weatherDataRetailer,
      } = req.body;

      if (!toRetailerId) {
        return res.status(400).json({
          success: false,
          error: "toRetailerId is required",
        });
      }

      // Try to convert toRetailerId to actual user ID if possible
      let retailerDbId = toRetailerId;

      // Check if it's already a valid user ID (starts with 'cm' for cuid)
      if (!toRetailerId.startsWith("cm")) {
        // Try to find retailer by username
        const retailerUser = await prisma.user.findUnique({
          where: { username: toRetailerId },
          select: { id: true, role: true },
        });

        if (retailerUser) {
          retailerDbId = retailerUser.id;
          console.log(
            `🔄 Converted retailer username "${toRetailerId}" to user ID "${retailerDbId}"`
          );
        } else {
          // Try to find by email as fallback
          const retailerByEmail = await prisma.user.findUnique({
            where: { email: toRetailerId },
            select: { id: true, role: true },
          });

          if (retailerByEmail) {
            retailerDbId = retailerByEmail.id;
            console.log(
              `🔄 Converted retailer email "${toRetailerId}" to user ID "${retailerDbId}"`
            );
          } else {
            // Retailer not found in system - allow transfer anyway with entered value
            // This supports cases where retailers aren't registered yet
            console.log(
              `⚠️ Retailer "${toRetailerId}" not found in database, using entered value`
            );
          }
        }
      } else {
        // Verify the ID exists (optional - just log if not found)
        const retailerExists = await prisma.user.findUnique({
          where: { id: toRetailerId },
          select: { id: true },
        });

        if (!retailerExists) {
          console.log(
            `⚠️ Retailer ID "${toRetailerId}" not found in database, using entered value`
          );
        }
      }

      const distributorId = req.user.id;
      const temperature = weatherDataRetailer?.temperature;
      const weather_desc = weatherDataRetailer?.weather_desc;
      const weather_main = weatherDataRetailer?.weather_main;
      const humidity = weatherDataRetailer?.humidity;

      const transferData = {
        transferLocation: transferLocation || null,
        latitude: latitude || null,
        longitude: longitude || null,
        notes: notes || "Transfer to retailer",
        conditions: conditions || null,
        documents: documents || [],
        signature: signature || null,
        temperature: temperature || null,
        weather_desc: weather_desc || null,
        weather_main: weather_main || null,
        humidity: humidity || null,
      };

      const { gateway, contract } = await blockchainService.connectToNetwork();

      // BLOCKCHAIN: Transfer batch (use retailerDbId - the validated user ID)
      const result = await contract.submitTransaction(
        "transferBatch",
        batchId,
        distributorId,
        "DISTRIBUTOR",
        retailerDbId,
        "RETAILER",
        JSON.stringify(transferData)
      );
      const transferRecord = JSON.parse(result.toString());

      // DATABASE: Store transfer record (use retailerDbId - the validated user ID)
      const dbTransfer = await prisma.batchTransfer.create({
        data: {
          batchId: batchId,
          fromActorId: distributorId,
          fromActorRole: "DISTRIBUTOR",
          toActorId: retailerDbId,
          toActorRole: "RETAILER",
          transferType: "OWNERSHIP_TRANSFER",
          transferLocation: transferLocation || null,
          latitude: latitude || null,
          longitude: longitude || null,
          conditions: conditions ? conditions : null,
          documents: documents || [],
          signature: signature || null,
          notes: notes || "Transfer to retailer",
          status: "COMPLETED",
          statusBefore: "IN_DISTRIBUTION",
          statusAfter: "RETAIL_READY",
          blockchainTxId: transferRecord.txId || null,
          blockchainHash: null,
          temperature: temperature ? parseFloat(temperature) : null,
          weather_desc: weather_desc || null,
          weather_main: weather_main || null,
          humidity: humidity ? parseFloat(humidity) : null,
        },
      });

      // Update batch status in database if exists
      const dbBatch = await prisma.batch.findUnique({
        where: { batchId: batchId },
        include: { processingRecords: true },
      });
      if (dbBatch.parentBatchId) {
        const parentBatch = await prisma.batch.findUnique({
          where: { id: dbBatch.parentBatchId },
          include: { processingRecords: true },
        });
        if (parentBatch) {
          dbBatch.processingRecords = parentBatch.processingRecords;
        }
      }
      if (dbBatch) {
        await prisma.batch.update({
          where: { batchId: batchId },
          data: { status: "RETAIL_READY" },
        });
      }

      const distributionRecords = await prisma.distributionRecord.findMany({
        where: { batchId: batchId },
        orderBy: { createdAt: "asc" },
      });

      const latestDistributing =
        distributionRecords.length > 0
          ? distributionRecords[distributionRecords.length - 1]
          : null;

      const latestProcessing =
        dbBatch.processingRecords.length > 0
          ? dbBatch.processingRecords[dbBatch.processingRecords.length - 1]
          : null;

      const startTime =
        latestDistributing?.createdAt?.getTime() ||
        latestProcessing?.processingDate?.getTime() ||
        dbBatch.createdAt.getTime();

      const endTime = dbTransfer.transferDate.getTime();
      const totalTimeCalc = Math.ceil((endTime - startTime) / 60000);

      let originCoords = null;
      if (
        latestDistributing?.warehouseLat &&
        latestDistributing?.warehouseLng
      ) {
        originCoords = {
          lat: parseFloat(latestDistributing.warehouseLat),
          lng: parseFloat(latestDistributing.warehouseLng),
        };
      } else if (latestProcessing?.latitude && latestProcessing?.longitude) {
        originCoords = {
          lat: parseFloat(latestProcessing.latitude),
          lng: parseFloat(latestProcessing.longitude),
        };
      }

      if (originCoords && latitude && longitude) {
        const routeData = await getORSRoute(originCoords, {
          lat: parseFloat(latitude),
          lng: parseFloat(longitude),
        });

        if (routeData) {
          await prisma.transportRoute.create({
            data: {
              batch: { connect: { id: dbBatch.id } },
              batchIdName: dbBatch.batchId,
              distributorId: req.user.id,
              originLat: originCoords.lat,
              originLng: originCoords.lng,
              destinationLat: parseFloat(latitude),
              destinationLng: parseFloat(longitude),
              estimatedTime: routeData.durationMinutes,
              distance: parseFloat(routeData.distanceKm),
              // idea is the eta will be the diff between when the farmer registered it the crop and when the processor accepts it for processing
              TotalTime: totalTimeCalc,
              timestamp: dbTransfer.transferDate,
              routePolyline: routeData.geometry,
              status: "DELIVERED",
            },
          });
        }
      }

      await gateway.disconnect();

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "TRANSFER_TO_RETAILER",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: { toRetailerId: retailerDbId, transferId: dbTransfer.id },
        },
      });

      res.json({
        success: true,
        message: `Batch ${batchId} successfully transferred to retailer`,
        data: { blockchainRecord: transferRecord, databaseRecord: dbTransfer },
      });
    } catch (error) {
      console.error("Transfer to retailer error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to transfer to retailer",
        details: error.message,
      });
    }
  }
);

// ============================================
// RETAILER ENDPOINTS
// ============================================

// Get batches available for retail (RETAIL_READY status)
app.get(
  "/api/retailer/available-batches",
  authenticate,
  authorize(["RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      // Get batches that have been transferred to retailer (RETAIL_READY status)
      const batches = await prisma.batch.findMany({
        where: {
          status: "RETAIL_READY",
        },
        include: {
          farmer: {
            include: {
              user: { select: { username: true } },
            },
          },
          farmLocation: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      res.json({
        success: true,
        data: batches,
        count: batches.length,
      });
    } catch (error) {
      console.error("Get available batches error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to get available batches",
        details: error.message,
      });
    }
  }
);

// Receive batch from distributor
app.post(
  "/api/retailer/receive/:batchId",
  authenticate,
  authorize(["RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const { notes, receiveLocation, receiveDate } = req.body;
      const retailerId = req.user.id;

      // Find the batch
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      if (batch.status !== "RETAIL_READY") {
        return res.status(400).json({
          success: false,
          error: `Cannot receive batch with status: ${batch.status}. Must be RETAIL_READY`,
        });
      }

      // Update batch status to IN_RETAIL
      const updatedBatch = await prisma.batch.update({
        where: { batchId: batchId },
        data: {
          status: "IN_RETAIL",
          updatedAt: new Date(),
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "RECEIVE_BATCH_RETAIL",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: { receiveLocation, notes },
        },
      });

      // Update blockchain
      try {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();
        await contract.submitTransaction(
          "updateBatchStatus",
          batchId,
          "IN_RETAIL",
          req.user.username,
          new Date().toISOString(),
          JSON.stringify({
            retailerId: retailerId,
            receiveLocation: receiveLocation || null,
            notes: notes || "Batch received at retail store",
          })
        );
        await gateway.disconnect();
        console.log(`✅ Blockchain updated: Batch ${batchId} set to IN_RETAIL`);
      } catch (blockchainError) {
        console.error("Blockchain update failed:", blockchainError);
      }

      res.json({
        success: true,
        message: `Batch ${batchId} received successfully`,
        data: updatedBatch,
      });
    } catch (error) {
      console.error("Receive batch error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to receive batch",
        details: error.message,
      });
    }
  }
);

// Get retailer's current inventory (IN_RETAIL status)
app.get(
  "/api/retailer/my-batches",
  authenticate,
  authorize(["RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const batches = await prisma.batch.findMany({
        where: {
          status: "IN_RETAIL",
        },
        include: {
          farmer: {
            include: {
              user: { select: { username: true } },
            },
          },
          farmLocation: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      res.json({
        success: true,
        data: batches,
        count: batches.length,
      });
    } catch (error) {
      console.error("Get my batches error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to get batches",
        details: error.message,
      });
    }
  }
);

// Mark batch as SOLD (close lifecycle)
app.post(
  "/api/retailer/mark-sold/:batchId",
  authenticate,
  authorize(["RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const { saleDate, soldBy, notes, finalCustomer } = req.body;
      const retailerId = req.user.id;

      // Find the batch
      const batch = await prisma.batch.findUnique({
        where: { batchId: batchId },
      });

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: "Batch not found",
        });
      }

      if (batch.status !== "IN_RETAIL") {
        return res.status(400).json({
          success: false,
          error: `Cannot mark batch as sold with status: ${batch.status}. Must be IN_RETAIL`,
        });
      }

      // Update batch status to SOLD
      const updatedBatch = await prisma.batch.update({
        where: { batchId: batchId },
        data: {
          status: "SOLD",
          updatedAt: new Date(),
        },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          userId: req.user.id,
          action: "MARK_BATCH_SOLD",
          resource: batchId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
          metadata: {
            saleDate: saleDate || new Date().toISOString(),
            soldBy: soldBy || req.user.username,
            notes,
            finalCustomer,
          },
        },
      });

      // Update blockchain - close lifecycle
      try {
        const { gateway, contract } =
          await blockchainService.connectToNetwork();
        await contract.submitTransaction(
          "updateBatchStatus",
          batchId,
          "SOLD",
          req.user.username,
          new Date().toISOString(),
          JSON.stringify({
            retailerId: retailerId,
            saleDate: saleDate || new Date().toISOString(),
            soldBy: soldBy || req.user.username,
            notes: notes || "Batch sold to final consumer",
            finalCustomer: finalCustomer || null,
            lifecycleClosed: true,
          })
        );
        await gateway.disconnect();
        console.log(
          `✅ Blockchain updated: Batch ${batchId} marked as SOLD - Lifecycle closed`
        );
      } catch (blockchainError) {
        console.error("Blockchain update failed:", blockchainError);
      }

      res.json({
        success: true,
        message: `Batch ${batchId} marked as SOLD successfully. Lifecycle closed.`,
        data: updatedBatch,
      });
    } catch (error) {
      console.error("Mark as sold error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to mark batch as sold",
        details: error.message,
      });
    }
  }
);

// Get sold batches
app.get(
  "/api/retailer/sold-batches",
  authenticate,
  authorize(["RETAILER", "ADMIN"]),
  async (req, res) => {
    try {
      const batches = await prisma.batch.findMany({
        where: {
          status: "SOLD",
        },
        include: {
          farmer: {
            include: {
              user: { select: { username: true } },
            },
          },
          farmLocation: true,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      res.json({
        success: true,
        data: batches,
        count: batches.length,
      });
    } catch (error) {
      console.error("Get sold batches error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to get sold batches",
        details: error.message,
      });
    }
  }
);

// ===============================
// GIS & ROUTING ENDPOINT
// ===============================

const geocodeAddress = async (address, state, country) => {
  const GEOCODE_URL = process.env.ARCGIS_GEOCODE_URL;
  const ARC_GIS_API_KEY = process.env.ARC_GIS_API_KEY;

  if (!address) {
    return null;
  }

  // Concatenate address for best results
  const fullAddress = `${address}, ${state || ""}, ${country || "Malaysia"}`;

  try {
    const response = await axios.get(GEOCODE_URL, {
      params: {
        f: "json",
        token: ARC_GIS_API_KEY,
        singleLine: fullAddress,
        outFields: "Addr_type", // Optional field to get address type
        forStorage: false, // Ensure compliance with service terms
      },
    });

    const candidates = response.data.candidates;

    if (candidates && candidates.length > 0) {
      const bestMatch = candidates[0];
      return {
        latitude: bestMatch.location.y,
        longitude: bestMatch.location.x,
        score: bestMatch.score,
      };
    }
    return null;
  } catch (error) {
    console.error("❌ ArcGIS Geocoding failed:", error.message);
    return null;
  }
};

// ============================================================================
// ML ADMIN ENDPOINTS - Fraud Detection Monitoring
// ============================================================================

/**
 * Get batches flagged by ML fraud detection
 */
app.get(
  "/api/ml/flagged-batches",
  authenticate,
  authorize(["ADMIN", "REGULATOR"]),
  async (req, res) => {
    try {
      const flaggedBatches = await prisma.batch.findMany({
        where: {
          notes: {
            contains: "⚠️  FLAGGED FOR REVIEW",
          },
        },
        include: {
          farmer: {
            include: {
              user: { select: { username: true, email: true } },
            },
          },
          farmLocation: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      res.json({
        success: true,
        count: flaggedBatches.length,
        batches: flaggedBatches,
      });
    } catch (error) {
      console.error("Error fetching flagged batches:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch flagged batches",
      });
    }
  }
);

/**
 * Get ML service statistics
 */
app.get("/api/ml/stats", authenticate, async (req, res) => {
  try {
    const mlAvailable = await checkMLService();

    if (!mlAvailable) {
      return res.json({
        success: true,
        mlServiceAvailable: false,
        message: "ML service is not currently available",
      });
    }

    const response = await axios.get(`${ML_SERVICE_URL}/api/ml/batch-stats`, {
      timeout: 3000,
    });

    res.json({
      success: true,
      mlServiceAvailable: true,
      stats: response.data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ArcGIS Token Refresh Endpoint
app.get("/api/refresh-token", async (req, res) => {
  const ARCGIS_TOKEN_URL = "https://www.arcgis.com/sharing/rest/oauth2/token";

  // Validate environment variables
  if (
    !process.env.ARCGIS_CLIENT_ID ||
    !process.env.ARCGIS_CLIENT_SECRET ||
    !process.env.ARCGIS_REFRESH_TOKEN
  ) {
    console.error("Missing ArcGIS Environment Variables.");
    return res.status(500).json({
      error: "Server Configuration Error: Missing credentials.",
    });
  }

  try {
    const params = new URLSearchParams({
      client_id: process.env.ARCGIS_CLIENT_ID,
      client_secret: process.env.ARCGIS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: process.env.ARCGIS_REFRESH_TOKEN,
    });

    const response = await axios.post(ARCGIS_TOKEN_URL, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (response.status !== 200) {
      return res.status(response.status).json({
        error:
          response.data.error_description ||
          response.data.error ||
          "ArcGIS token refresh failed.",
      });
    }

    res.json({
      access_token: response.data.access_token,
      expires_in: response.data.expires_in,
    });
  } catch (error) {
    console.error("Internal Server Error during token refresh:", error.message);
    res.status(500).json({
      error: "Internal Server Error during token refresh.",
    });
  }
});

// OpenWeather API Proxy Endpoint
app.get("/api/weather", async (req, res) => {
  const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
  const lat = req.query.lat;
  const lon = req.query.lon;

  if (!lat || !lon) {
    return res.status(400).json({
      error: "Missing lat or lon parameter",
    });
  }

  if (!OPENWEATHER_API_KEY) {
    console.error("Missing OPENWEATHER_API_KEY environment variable.");
    return res.status(500).json({
      error: "Server Configuration Error: Missing weather API key.",
    });
  }

  try {
    const [weatherResponse, forecastResponse] = await Promise.all([
      axios.get(
        `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric`
      ),
      axios.get(
        `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${OPENWEATHER_API_KEY}&units=metric`
      ),
    ]);

    console.log("Successfully fetched weather and forecast data");

    res.json({
      weather: weatherResponse.data,
      forecast: forecastResponse.data,
    });
  } catch (error) {
    console.error("Weather API proxy error:", error.message);

    const status = error.response?.status || 500;
    res.status(status).json({
      success: false,
      error: "Failed to connect to Weather API",
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// 404 handler (MUST be last!)
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🔄 Gracefully shutting down...");

  try {
    await prisma.$disconnect();
    console.log("✅ Database disconnected");
  } catch (error) {
    console.error("❌ Error disconnecting database:", error);
  }

  process.exit(0);
});

// Start server
const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    console.log("✅ Database connected successfully");

    // Test blockchain connection (non-blocking)
    try {
      const result = await blockchainService.connectToNetwork();
      if (result && result.gateway && result.contract) {
        console.log("✅ Blockchain connected successfully");
        await result.gateway.disconnect();
      } else {
        console.log(
          "⚠️  Blockchain connection failed - server will start in database-only mode"
        );
      }
    } catch (blockchainError) {
      console.log(
        "⚠️  Blockchain network not available - server will start in database-only mode"
      );
      console.log("   Make sure the Hyperledger Fabric network is running:");
      console.log("   npm run blockchain:start");
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        "🚀 Agricultural Supply Chain API Server with Database Integration Started"
      );
      console.log(`📡 Server running on: http://localhost:${PORT}`);
      console.log(`🗃️  Database: PostgreSQL with Prisma ORM`);
      console.log(`🔗 Blockchain network: mychannel`);
      console.log(`📦 Smart contract: agricultural-contract`);
      console.log(`🌐 Enhanced API Endpoints:`);
      console.log(`   Authentication:`);
      console.log(`     POST /api/auth/register      - Register new user`);
      console.log(`     POST /api/auth/login         - Login user`);
      console.log(`     GET  /api/auth/profile       - Get user profile`);
      console.log(`   Batch Management:`);
      console.log(
        `     POST /api/batch/create       - Create new crop batch (Farmers)`
      );
      console.log(
        `     GET  /api/batch/:batchId     - Get batch details (Role-based)`
      );
      console.log(`     PUT  /api/batch/:id/status   - Update batch status`);
      console.log(`     GET  /api/farmer/my-batches  - Get farmer's batches`);
      console.log(`   Processor Operations:`);
      console.log(
        `     GET  /api/processor/available-batches - Get available batches (Processors)`
      );
      console.log(
        `     POST /api/processor/process/:batchId  - Start batch processing`
      );
      console.log(
        `     GET  /api/processor/my-processing     - Get processing history`
      );
      console.log(
        `     PUT  /api/processor/complete/:batchId - Complete batch processing`
      );
      console.log(`   Verification & QR:`);
      console.log(`     GET  /api/verify/:batchId    - Verify batch (QR scan)`);
      console.log(`     GET  /api/qr/:batchId        - Get QR code for batch`);
      console.log(`   Admin & Analytics:`);
      console.log(
        `     GET  /api/batches            - Get all batches (Admin/Regulator)`
      );
      console.log(`     GET  /api/dashboard          - Role-based dashboard`);
      console.log(`     GET  /api/batch/:id/integrity - Data integrity check`);
      console.log(`   System:`);
      console.log(`     GET  /                       - API health check`);
      console.log(`     GET  /api/batch/check/:id    - Check batch existence`);
      console.log("");
      console.log(
        "🔐 Authentication: Bearer JWT token required for protected endpoints"
      );
      console.log(
        "📊 Database & Blockchain: Hybrid storage with cross-verification"
      );
      console.log(
        "🛡️  Security: Role-based access control + data integrity checks"
      );
      console.log("");
      console.log("💡 Test with: curl http://localhost:3000");
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
