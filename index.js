const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

// 🔥 FIX: Set Server Timezone to IST
process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone set to: ${process.env.TZ}`);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ---------- Environment Variables ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const ADMIN_ROLL_NUMBERS = ['24CSE48'];

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI environment variable is not set!');
  process.exit(1);
}

// ---------- Rate Limiting ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, try again after 15 minutes.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down.' }
});

const securityLogLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many suspicious attempts! Blocked for 1 hour.' }
});

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);
app.use('/api/attendance/mark', securityLogLimiter);
app.use('/api/attendance/mark-fullday', securityLogLimiter);

// ---------- Zod Validation Schemas ----------
const registerSchema = z.object({
  name: z.string().min(2, "Name too short").max(50),
  rollNo: z.string().regex(/^\d{2}(CSE|AIDS)\d{2}$/, "Invalid Roll No format"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  deviceId: z.string().optional()
});

const loginSchema = z.object({
  rollNo: z.string().min(1, "Roll No required"),
  password: z.string().min(1, "Password required"),
  deviceId: z.string().optional()
});

// ---------- 🔥 UPDATED TIMETABLE (Thursday now has 6 lectures) ----------
const TIME_TABLE = {
  Monday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'DAA - Design & Analysis of Algorithm', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'CN - Computer Network', 'WT - Web Technology'],
  Tuesday: ['WT - Web Technology', 'ECO - Economics for Engineers', 'Internet Lab (Ms. Geeta)', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'BDA - Big Data Analytics'],
  Wednesday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'FLA - Formal Language & Automata', 'WT - Web Technology', 'CN LAB - Computer Network Lab'],
  // 🔥 FIXED: Thursday now has 6 lectures (added WT - Web Technology)
  Thursday: ['BDA - Big Data Analytics', 'WT - Web Technology', 'CN - Computer Network', 'DAA - Design & Analysis of Algorithm', 'DAA LAB - Algorithm Lab', 'HRM - Human Resource Mgmt'],
  Friday: ['DAA - Design & Analysis of Algorithm', 'CN - Computer Network', 'FLA - Formal Language & Automata', 'BDA - Big Data Analytics', 'WT LAB - Web Technology Lab']
};

// ---------- MongoDB Connection ----------
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

// ---------- Mongoose Schemas ----------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: null },
  role: { type: String, enum: ['student', 'faculty', 'admin'], default: 'student' },
  faceDescriptor: { type: [Number], default: [] },
  boundDeviceId: { type: String, default: null },
  lastKnownIP: { type: String, default: null },
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  anomalyFlag: { type: Boolean, default: false },
  anomalyDetectedAt: { type: Date, default: null },
  activeSession: { type: String, default: null },
  deviceFingerprint: { type: Object, default: null },
  failedAttempts: { type: Number, default: 0 },
  blockUntil: { type: Date, default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  selfie: { type: String, default: null },
  deviceFingerprint: { type: Object, default: null },
  isVerified: { type: Boolean, default: false }
}, { timestamps: true });

const holidaySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  reason: { type: String, default: 'College Holiday' }
}, { timestamps: true });

const noticeSchema = new mongoose.Schema({
  title: String,
  message: String,
  date: { type: Date, default: Date.now }
});

const suspiciousLogSchema = new mongoose.Schema({
  rollNo: String,
  name: String,
  type: { type: String, enum: ['FAKE_GPS', 'IP_MISMATCH', 'PROXY', 'MULTIPLE_DEVICES', 'TIME_VIOLATION', 'SELFIE_MISMATCH', 'BLOCKED'] },
  details: String,
  location: { latitude: Number, longitude: Number },
  ipAddress: String,
  deviceFingerprint: Object,
  createdAt: { type: Date, default: Date.now }
});

const blacklistSchema = new mongoose.Schema({
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true }
});

const qrCodeSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  passcode: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const SuspiciousLog = mongoose.model('SuspiciousLog', suspiciousLogSchema);
const BlacklistToken = mongoose.model('BlacklistToken', blacklistSchema);
const QRCode = mongoose.model('QRCode', qrCodeSchema);

// ---------- Helper Functions ----------
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function checkLocation(lat, lng) {
  const COLLEGE_LAT = 28.4509370, COLLEGE_LNG = 76.7688120, R = 6371000;
  
  if (!lat || !lng || lat === 0 || lng === 0) {
    return { isInside: false, distance: "GPS Disconnected" };
  }

  const dLat = (lat - COLLEGE_LAT) * (Math.PI / 180);
  const dLon = (lng - COLLEGE_LNG) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(COLLEGE_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const distance = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

  return { isInside: distance <= 50, distance: distance.toFixed(0) };
}

async function checkStudentBlocked(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return { blocked: false };
  
  if (user.blockUntil && user.blockUntil > new Date()) {
    return { 
      blocked: true, 
      message: `⛔ Blocked until ${user.blockUntil.toLocaleString()}. Contact Admin.`
    };
  }
  
  if (user.blockUntil && user.blockUntil <= new Date()) {
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
  }
  
  return { blocked: false };
}

async function logSuspiciousActivity(rollNo, name, type, details, location, ipAddress, fingerprint) {
  try {
    await SuspiciousLog.create({
      rollNo,
      name,
      type,
      details,
      location,
      ipAddress,
      deviceFingerprint: fingerprint
    });
    console.log(`🔴 Suspicious: ${type} for ${rollNo}`);
  } catch (err) {
    console.error('Log failed:', err);
  }
}

async function incrementFailedAttempts(rollNo, name, reason, location, ipAddress, fingerprint) {
  const user = await User.findOne({ rollNo });
  if (!user) return;
  
  user.failedAttempts = (user.failedAttempts || 0) + 1;
  
  if (user.failedAttempts >= 5) {
    user.blockUntil = new Date(Date.now() + 60 * 60 * 1000);
    await logSuspiciousActivity(rollNo, name, 'BLOCKED', `Blocked for 1 hour. Reason: ${reason}`, location, ipAddress, fingerprint);
    console.log(`🚫 ${rollNo} blocked for 1 hour`);
  }
  
  await user.save();
}

function detectAnomaly(user, lat, lng, reqIP, fingerprint) {
  const MIN_TIME_BETWEEN_ATTENDANCE = 10 * 60 * 1000;
  
  if (user.lastKnownIP && user.lastKnownIP !== reqIP) {
    if (user.lastAttendanceTime) {
      const timeDiff = Date.now() - new Date(user.lastAttendanceTime).getTime();
      if (timeDiff < MIN_TIME_BETWEEN_ATTENDANCE) {
        return { 
          isAnomaly: true, 
          type: 'IP_MISMATCH',
          reason: `IP changed from ${user.lastKnownIP} to ${reqIP} within ${Math.round(timeDiff/60000)} min`
        };
      }
    }
  }
  
  if (user.lastAttendanceLocation && user.lastAttendanceLocation.latitude) {
    const distance = calculateDistance(
      user.lastAttendanceLocation.latitude, 
      user.lastAttendanceLocation.longitude,
      lat, lng
    );
    
    if (distance > 5000 && user.lastAttendanceTime) {
      const timeDiff = Date.now() - new Date(user.lastAttendanceTime).getTime();
      if (timeDiff < MIN_TIME_BETWEEN_ATTENDANCE) {
        return { 
          isAnomaly: true, 
          type: 'FAKE_GPS',
          reason: `Impossible travel: ${Math.round(distance)}m in ${Math.round(timeDiff/60000)} min`
        };
      }
    }
  }
  
  if (user.deviceFingerprint && fingerprint) {
    const oldFP = JSON.stringify(user.deviceFingerprint);
    const newFP = JSON.stringify(fingerprint);
    if (oldFP !== newFP && user.lastAttendanceTime) {
      const timeDiff = Date.now() - new Date(user.lastAttendanceTime).getTime();
      if (timeDiff < MIN_TIME_BETWEEN_ATTENDANCE) {
        return { 
          isAnomaly: true, 
          type: 'MULTIPLE_DEVICES',
          reason: 'Device fingerprint changed! Proxy attempt.'
        };
      }
    }
  }
  
  return { isAnomaly: false };
}

async function autoResetAnomalyFlags() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await User.updateMany(
      { anomalyFlag: true, anomalyDetectedAt: { $lt: oneDayAgo } },
      { $set: { anomalyFlag: false, anomalyDetectedAt: null, lastKnownIP: null, lastAttendanceLocation: {} } }
    );
    if (result.modifiedCount > 0) {
      console.log(`🔄 Auto-unblocked ${result.modifiedCount} students`);
    }
  } catch (err) {
    console.error('Auto-reset failed:', err.message);
  }
}

setInterval(autoResetAnomalyFlags, 60 * 60 * 1000);
autoResetAnomalyFlags();

// ---------- RBAC Middleware ----------
const verifyRole = (roles) => {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Access Denied" });
    try {
      const verified = jwt.verify(token, JWT_SECRET);
      if (!roles.includes(verified.role)) {
        return res.status(403).json({ error: "Unauthorized Role!" });
      }
      req.user = verified;
      next();
    } catch (err) {
      res.status(400).json({ error: "Invalid Token" });
    }
  };
};

const checkActiveSession = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access Denied" });
  try {
    const blacklisted = await BlacklistToken.findOne({ token });
    if (blacklisted) {
      return res.status(401).json({ error: "Session expired. Please login again." });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active & Secured!'));

// ----- Auth Routes -----
app.post('/api/auth/register', async (req, res) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.errors[0].message });
    }
    const { name, rollNo, password, deviceId } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();

    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'Roll number already registered!' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : 'student';
    
    await new User({ 
      name, 
      rollNo: cleanRoll, 
      password: hashedPassword, 
      role,
      boundDeviceId: deviceId || null
    }).save();

    res.status(201).json({ message: 'Registration successful! Please login.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.errors[0].message });
    }
    const { rollNo, password, deviceId } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    
    console.log(`📱 Login attempt for ${cleanRoll}`);
    
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });

    user.failedAttempts = 0;
    user.blockUntil = null;

    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) {
        user.boundDeviceId = deviceId;
        await user.save();
        console.log(`🔗 Device bound for ${cleanRoll}`);
      } else if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
      }
    }

    if (user.activeSession) {
      await BlacklistToken.create({
        token: user.activeSession,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
    }

    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : user.role;
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role }, JWT_SECRET, { expiresIn: '7d' });
    
    user.activeSession = token;
    await user.save();
    
    res.json({ 
      message: 'Login successful!', 
      token, 
      user: { name: user.name, rollNo: user.rollNo, role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      await BlacklistToken.create({
        token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
      const decoded = jwt.decode(token);
      if (decoded) {
        await User.findOneAndUpdate({ rollNo: decoded.rollNo }, { activeSession: null });
      }
    }
    res.json({ message: 'Logged out successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Face Mesh -----
app.post('/api/face/enroll', async (req, res) => {
  try {
    const { rollNo, faceDescriptor } = req.body;
    if (!rollNo || !faceDescriptor || faceDescriptor.length === 0) {
      return res.status(400).json({ error: 'Valid Roll No and Face Neural Mesh required!' });
    }
    const cleanRoll = rollNo.trim().toUpperCase();
    const updatedUser = await User.findOneAndUpdate(
      { rollNo: cleanRoll },
      { faceDescriptor },
      { new: true }
    );
    if (!updatedUser) return res.status(404).json({ error: 'Student Profile Not Found!' });
    res.json({ message: 'Face ID Enrolled & Synced!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/face/get/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user || !user.faceDescriptor || user.faceDescriptor.length === 0) {
      return res.status(404).json({ enrolled: false, message: 'Face ID Not Enrolled' });
    }
    res.json({ enrolled: true, faceDescriptor: user.faceDescriptor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Admin Routes -----
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo, newPassword } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const hashedPassword = await bcrypt.hash(newPassword || '123456', 10);
    const updated = await User.findOneAndUpdate({ rollNo: cleanRoll }, { password: hashedPassword });
    if (!updated) return res.status(404).json({ error: 'Student Roll No not found!' });
    res.json({ message: `Password reset for ${cleanRoll}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: `Student ${cleanRoll} not found!` });
    const oldDeviceId = user.boundDeviceId;
    user.boundDeviceId = null;
    await user.save();
    res.json({ message: `✅ Device binding reset for ${cleanRoll}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-anomaly', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: `Student ${cleanRoll} not found!` });
    user.anomalyFlag = false;
    user.anomalyDetectedAt = null;
    user.lastKnownIP = null;
    user.lastAttendanceTime = null;
    user.lastAttendanceLocation = {};
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
    res.json({ message: `✅ Anomaly flag reset for ${cleanRoll}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-rollno', async (req, res) => {
  try {
    const { requesterRollNo, oldRoll, newRoll } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanOld = oldRoll.trim().toUpperCase();
    const cleanNew = newRoll.trim().toUpperCase();
    await User.findOneAndUpdate({ rollNo: cleanOld }, { rollNo: cleanNew });
    await Attendance.updateMany({ rollNo: cleanOld }, { rollNo: cleanNew });
    res.json({ message: `Roll Number updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/delete-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanTarget = targetRollNo.trim().toUpperCase();
    await User.findOneAndDelete({ rollNo: cleanTarget });
    await Attendance.deleteMany({ rollNo: cleanTarget });
    res.json({ message: `Account and records deleted for ${cleanTarget}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/faculty/override', verifyRole(['faculty', 'admin']), async (req, res) => {
  try {
    const { studentRollNo, subject, date, status } = req.body;
    await Attendance.findOneAndUpdate(
      { rollNo: studentRollNo, subject, date },
      { status, isVerified: true },
      { new: true, upsert: true }
    );
    res.json({ message: "Attendance updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- QR Code Routes -----
app.post('/api/admin/generate-qr', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const passcode = Math.floor(1000 + Math.random() * 9000).toString();
    const token = `BMERP_QR_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await QRCode.deleteMany({});
    await QRCode.create({ token, passcode, expiresAt });
    console.log(`✅ QR generated: ${passcode}`);
    res.json({ message: 'QR generated!', passcode, token, expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/verify-qr', async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Passcode required!' });
    const qrRecord = await QRCode.findOne({ passcode });
    if (!qrRecord) return res.status(400).json({ error: 'Invalid passcode!' });
    if (qrRecord.expiresAt < new Date()) {
      await QRCode.deleteOne({ _id: qrRecord._id });
      return res.status(400).json({ error: 'QR expired! Please refresh.' });
    }
    await QRCode.deleteOne({ _id: qrRecord._id });
    res.json({ message: 'QR verified!', verified: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Notices -----
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 }).limit(3);
    res.json(notices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    if (!message || message.trim() === "") {
      await Notice.deleteMany({});
      return res.json({ message: 'Notices cleared!' });
    }
    await Notice.deleteMany({});
    await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Notice published!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ----- Suspicious Activity Logs -----
app.get('/api/admin/suspicious-logs/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const logs = await SuspiciousLog.find().sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 NEW: Clear Suspicious Logs
app.delete('/api/admin/clear-suspicious-logs/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const result = await SuspiciousLog.deleteMany({});
    res.json({ message: `✅ ${result.deletedCount} logs cleared permanently!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/flagged-students/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const flaggedStudents = await User.find({ anomalyFlag: true })
      .select('name rollNo anomalyFlag anomalyDetectedAt lastKnownIP lastAttendanceTime');
    res.json(flaggedStudents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/auto-unblock-status/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const flaggedStudents = await User.find({ anomalyFlag: true })
      .select('name rollNo anomalyFlag anomalyDetectedAt');
    const status = flaggedStudents.map(s => {
      const timeLeft = s.anomalyDetectedAt ? 
        24 - ((Date.now() - new Date(s.anomalyDetectedAt).getTime()) / (60 * 60 * 1000)) : 0;
      return {
        rollNo: s.rollNo,
        name: s.name,
        timeLeftHours: Math.max(0, Math.round(timeLeft * 10) / 10),
        willAutoUnblockAt: s.anomalyDetectedAt ? 
          new Date(new Date(s.anomalyDetectedAt).getTime() + 24 * 60 * 60 * 1000).toLocaleString() : 'N/A'
      };
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/all-students/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const students = await User.find({ role: 'student' })
      .select('name rollNo role anomalyFlag anomalyDetectedAt boundDeviceId createdAt deviceFingerprint failedAttempts blockUntil')
      .sort({ rollNo: 1 });
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Attendance Marking -----
app.post('/api/attendance/mark', checkActiveSession, async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, selfie, deviceFingerprint, qrVerified } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];

    if (today.getDay() === 0 || today.getDay() === 6) {
      return res.status(400).json({ error: 'Weekend! College was OFF.' });
    }

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) {
      return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });
    }

    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: blockCheck.message });
    }

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll, name, `Outside boundary (${locCheck.distance}m)`, { latitude, longitude }, req.ip, deviceFingerprint);
      await logSuspiciousActivity(rollNo, name, 'FAKE_GPS', `Outside boundary (${locCheck.distance}m)`, { latitude, longitude }, req.ip, deviceFingerprint);
      return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });
    }

    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    // Selfie check
    if (selfie && (!user.faceDescriptor || user.faceDescriptor.length === 0)) {
      return res.status(400).json({ error: 'Enroll face first!' });
    }

    if (deviceFingerprint && !user.deviceFingerprint) {
      user.deviceFingerprint = deviceFingerprint;
      await user.save();
    }

    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const anomaly = detectAnomaly(user, latitude, longitude, clientIP, deviceFingerprint);
    
    if (anomaly.isAnomaly) {
      await incrementFailedAttempts(cleanRoll, name, anomaly.reason, { latitude, longitude }, clientIP, deviceFingerprint);
      user.anomalyFlag = true;
      user.anomalyDetectedAt = new Date();
      await user.save();
      await logSuspiciousActivity(cleanRoll, name, anomaly.type, anomaly.reason, { latitude, longitude }, clientIP, deviceFingerprint);
      return res.status(403).json({ 
        error: '⛔ Attendance Blocked! Suspicious activity detected. Auto-unblock after 24 hours.',
        reason: anomaly.reason 
      });
    }

    // Lab check: Only 1 lecture per lab per day
    const isLab = subject.includes("LAB") || subject.includes("Lab");
    const todayEntries = await Attendance.find({ rollNo: cleanRoll, subject, date: todayDate });
    if (isLab && todayEntries.length >= 1) {
      return res.status(400).json({ error: `Already marked for ${subject} today! (Lab - 1 lecture only)` });
    }

    user.failedAttempts = 0;
    user.blockUntil = null;

    await new Attendance({ 
      rollNo: cleanRoll, 
      studentName: name, 
      subject, 
      date: todayDate, 
      status: 'Present', 
      location: { latitude, longitude },
      ipAddress: clientIP,
      selfie: selfie || null,
      deviceFingerprint: deviceFingerprint || null,
      isVerified: !!selfie
    }).save();

    user.lastKnownIP = clientIP;
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    if (deviceFingerprint) user.deviceFingerprint = deviceFingerprint;
    await user.save();
    
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!`, verified: !!selfie });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance/mark-fullday', checkActiveSession, async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude, selfie, deviceFingerprint } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') {
      return res.status(400).json({ error: 'Weekend! College was OFF.' });
    }

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) {
      return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });
    }

    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll, name, `Outside boundary (${locCheck.distance}m)`, { latitude, longitude }, req.ip, deviceFingerprint);
      return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });
    }

    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const anomaly = detectAnomaly(user, latitude, longitude, clientIP, deviceFingerprint);
    
    if (anomaly.isAnomaly) {
      await incrementFailedAttempts(cleanRoll, name, anomaly.reason, { latitude, longitude }, clientIP, deviceFingerprint);
      user.anomalyFlag = true;
      user.anomalyDetectedAt = new Date();
      await user.save();
      await logSuspiciousActivity(cleanRoll, name, anomaly.type, anomaly.reason, { latitude, longitude }, clientIP, deviceFingerprint);
      return res.status(403).json({ 
        error: '⛔ Attendance Blocked! Suspicious activity detected. Auto-unblock after 24 hours.',
        reason: anomaly.reason 
      });
    }

    // 🔥 UPDATED: Thursday now has 6 lectures (WT added)
    const todaySubjects = TIME_TABLE[dayName] || ['General Class'];
    let markedCount = 0;

    for (let sub of todaySubjects) {
      const exists = await Attendance.findOne({ rollNo: cleanRoll, subject: sub, date: todayDate });
      if (!exists) {
        await new Attendance({ 
          rollNo: cleanRoll, 
          studentName: name, 
          subject: sub, 
          date: todayDate, 
          status: 'Present', 
          location: { latitude, longitude },
          ipAddress: clientIP,
          deviceFingerprint: deviceFingerprint || null,
          isVerified: !!selfie
        }).save();
        markedCount++;
      }
    }
    
    user.lastKnownIP = clientIP;
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();

    if (markedCount === 0) return res.status(400).json({ error: 'Full Day already marked!' });
    res.status(201).json({ message: `✅ Full Day Marked (${markedCount} Lectures)!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/manual-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, status } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });

    const parts = date.split('-');
    const targetDateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[targetDateObj.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') {
      return res.status(400).json({ error: 'Target date is a Weekend!' });
    }

    const targetSubjects = TIME_TABLE[dayName] || ['General Class'];
    let markedCount = 0;

    for (let sub of targetSubjects) {
      const exists = await Attendance.findOne({ rollNo: targetRoll, subject: sub, date });
      if (!exists) {
        await new Attendance({ 
          rollNo: targetRoll, 
          studentName: user.name, 
          subject: sub, 
          date, 
          status: status || 'Present', 
          location: { latitude: 28.4509370, longitude: 76.7688120 },
          ipAddress: 'admin-manual',
          isVerified: true
        }).save();
        markedCount++;
      }
    }
    res.status(201).json({ message: `Marked ${markedCount} lectures for ${user.name} on ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Holidays -----
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'College Holiday' }, { upsert: true, new: true });
    res.json({ message: `Holiday declared for ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/holidays', async (req, res) => {
  try {
    const holidays = await Holiday.find();
    res.json(holidays);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- History & Analytics -----
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const history = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    const allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(allRecords);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const records = await Attendance.find({ rollNo: cleanRoll });
    
    let subjectStats = {};
    records.forEach(rec => {
      if (!subjectStats[rec.subject]) subjectStats[rec.subject] = { present: 0, total: 0 };
      subjectStats[rec.subject].total += 1;
      if (rec.status === 'Present') subjectStats[rec.subject].present += 1;
    });

    res.json(subjectStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Global Error Handlers ----------
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    
