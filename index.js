const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const helmet = require('helmet');

process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone set to: ${process.env.TZ}`);

const app = express();

// ---------- Security Headers ----------
app.use(helmet());

// ---------- CORS with Whitelist (FIX #32) ----------
const allowedOrigins = [
  'https://your-frontend-domain.com',
  'https://7361-ui.github.io',
  'http://localhost:3000',
  'http://localhost:5000',
  'https://bm-group-erp.netlify.app'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---------- File Upload Setup (FIX #4) ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ---------- Environment Variables ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex'); // FIX #28
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(64).toString('hex');
const ADMIN_ROLL_NUMBERS = ['24CSE48'];
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 500;
const SEMESTER_START = new Date(2026, 6, 15);
const SEMESTER_END = new Date(2026, 11, 31);

// ---------- Email Setup (FIX #16) ----------
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');

let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  console.log('📧 Email transporter configured');
}

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI environment variable is not set!');
  process.exit(1);
}

// ---------- Rate Limiting ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts, try again after 15 minutes.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 100, message: { error: 'Too many requests, please slow down.' } });

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// ---------- Zod Validation Schemas ----------
const registerSchema = z.object({
  name: z.string().min(2, "Name too short").max(50),
  rollNo: z.string().regex(/^\d{2}(CSE|AIDS)\d{2}$/, "Invalid Roll No format"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  deviceId: z.string().optional(),
  role: z.enum(['student', 'faculty']).optional().default('student')
});

const loginSchema = z.object({
  rollNo: z.string().min(1, "Roll No required"),
  password: z.string().min(1, "Password required"),
  deviceId: z.string().optional()
});

const forgotPasswordSchema = z.object({
  rollNo: z.string().min(1, "Roll No required"),
  email: z.string().email("Valid email required")
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token required"),
  newPassword: z.string().min(6, "Password must be at least 6 characters")
});

// ---------- Timetable ----------
const TIME_TABLE = {
  Monday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'DAA - Design & Analysis of Algorithm', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'CN - Computer Network', 'LIB - Library'],
  Tuesday: ['WT - Web Technology', 'ECO - Economics for Engineers', 'Internet Lab (Ms. Geeta)', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'BDA - Big Data Analytics'],
  Wednesday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'FLA - Formal Language & Automata', 'WT - Web Technology', 'CN LAB - Computer Network Lab'],
  Thursday: ['BDA - Big Data Analytics', 'WT - Web Technology', 'CN - Computer Network', 'DAA - Design & Analysis of Algorithm', 'DAA LAB - Algorithm Lab', 'HRM - Human Resource Mgmt'],
  Friday: ['DAA - Design & Analysis of Algorithm', 'CN - Computer Network', 'FLA - Formal Language & Automata', 'BDA - Big Data Analytics', 'WT LAB - Web Technology Lab']
};

// ---------- MongoDB Connection ----------
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
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
  boundDeviceId: { type: String, default: null },
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  failedAttempts: { type: Number, default: 0 },
  blockUntil: { type: Date, default: null },
  email: { type: String, default: null },
  profilePic: { type: String, default: null },
  profilePicPath: { type: String, default: null },
  semester: { type: String, default: '5th' },
  branch: { type: String, default: 'CSE' },
  activeSession: { type: String, default: null },
  refreshToken: { type: String, default: null },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  isEmailVerified: { type: Boolean, default: false }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday', 'Leave Requested', 'Leave Approved', 'Leave Rejected'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  markedBy: { type: String, default: 'student' },
  leaveReason: { type: String, default: null },
  correctionLog: [{ 
    changedBy: String,
    oldStatus: String,
    newStatus: String,
    reason: String,
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const holidaySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  reason: { type: String, default: 'College Holiday' }
}, { timestamps: true });

const noticeSchema = new mongoose.Schema({
  title: String,
  message: String,
  date: { type: Date, default: Date.now },
  target: { type: String, enum: ['all', 'students', 'faculty', 'admin'], default: 'all' }
});

const passcodeSchema = new mongoose.Schema({
  passcode: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

const auditLogSchema = new mongoose.Schema({
  rollNo: String,
  action: String,
  details: String,
  ipAddress: String,
  timestamp: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  subject: String,
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);
const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const Message = mongoose.model('Message', messageSchema);

// ---------- Helper: Check if date is holiday or weekend ----------
async function checkDateStatus(dateStr) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const parts = dateStr.split('-');
  const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayName = days[dateObj.getDay()];
  
  if (dayName === 'Saturday' || dayName === 'Sunday') {
    return { isBlocked: true, type: 'WEEKEND', message: `📅 ${dayName}: College Closed (Weekend)`, dayName };
  }
  
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    return { isBlocked: true, type: 'HOLIDAY', message: `🎉 Holiday: ${holiday.reason}`, dayName, holiday: holiday.reason };
  }
  
  return { isBlocked: false, dayName };
}

// ---------- Helper: Get Working Days ----------
async function getWorkingDays(startDate, endDate) {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;
  
  let workingDays = 0;
  const holidays = await Holiday.find({ date: { $gte: start.toISOString().split('T')[0], $lte: end.toISOString().split('T')[0] } });
  const holidaySet = new Set(holidays.map(h => h.date));
  let current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const dayOfWeek = current.getDay();
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    if (!isWeekend && !holidaySet.has(dateStr)) {
      workingDays++;
    }
    current.setDate(current.getDate() + 1);
  }
  return workingDays;
}

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
  if (!lat || !lng || lat === 0 || lng === 0) {
    return { isInside: false, distance: "GPS Disconnected" };
  }
  const distance = calculateDistance(lat, lng, COLLEGE_LAT, COLLEGE_LNG);
  return { isInside: distance <= COLLEGE_RADIUS, distance: distance.toFixed(0) };
}

async function checkStudentBlocked(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return { blocked: false };
  if (user.blockUntil && user.blockUntil > new Date()) {
    return { blocked: true, message: `⛔ Blocked until ${user.blockUntil.toLocaleString()}. Contact Admin.` };
  }
  if (user.blockUntil && user.blockUntil <= new Date()) {
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
  }
  return { blocked: false };
}

async function incrementFailedAttempts(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return;
  user.failedAttempts = (user.failedAttempts || 0) + 1;
  if (user.failedAttempts >= 5) {
    user.blockUntil = new Date(Date.now() + 60 * 60 * 1000);
    await AuditLog.create({ rollNo, action: 'ACCOUNT_BLOCKED', details: 'Blocked for 1 hour due to 5 failed attempts' });
    console.log(`🚫 ${rollNo} blocked for 1 hour`);
    // Send email alert (FIX #16)
    if (transporter && user.email) {
      try {
        await transporter.sendMail({
          from: EMAIL_USER,
          to: user.email,
          subject: '⚠️ Account Blocked - BM Group ERP',
          html: `<h3>Your account has been blocked for 1 hour</h3><p>Reason: 5 failed attendance attempts</p><p>Roll No: ${rollNo}</p><p>Time: ${new Date().toLocaleString()}</p>`
        });
      } catch(e) {}
    }
  }
  await user.save();
}

// ---------- Email Helper (FIX #16) ----------
async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log('📧 Email not configured');
    return false;
  }
  try {
    await transporter.sendMail({ from: EMAIL_USER, to, subject, html });
    return true;
  } catch(e) {
    console.error('Email error:', e);
    return false;
  }
}

// ---------- RBAC Middleware ----------
const verifyRole = (roles) => (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access Denied" });
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    if (!roles.includes(verified.role)) return res.status(403).json({ error: "Unauthorized Role!" });
    req.user = verified;
    next();
  } catch (err) { res.status(400).json({ error: "Invalid Token" }); }
};

// ---------- Refresh Token Middleware (FIX #31) ----------
const generateTokens = (user) => {
  const accessToken = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: user._id, rollNo: user.rollNo }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
};

app.post('/api/auth/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }
    const tokens = generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    await user.save();
    res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  } catch(err) {
    res.status(403).json({ error: 'Invalid refresh token' });
  }
});

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));

// ----- Auth Routes -----
app.post('/api/auth/register', async (req, res) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { name, rollNo, password, deviceId, role } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'Roll number already registered!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const finalRole = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : role || 'student';
    await new User({ name, rollNo: cleanRoll, password: hashedPassword, role: finalRole, boundDeviceId: deviceId || null }).save();
    await AuditLog.create({ rollNo: cleanRoll, action: 'REGISTER', details: `New ${finalRole} registered` });
    res.status(201).json({ message: 'Registration successful! Please login.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { rollNo, password, deviceId } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    console.log(`📱 Login attempt for ${cleanRoll}`);
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    user.failedAttempts = 0;
    user.blockUntil = null;
    
    const isAdmin = ADMIN_ROLL_NUMBERS.includes(cleanRoll);
    
    // Device binding only for students (not admin, not faculty)
    if (!isAdmin && user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { 
        user.boundDeviceId = deviceId; 
        await user.save(); 
      }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
      }
    }
    
    const tokens = generateTokens(user);
    user.refreshToken = tokens.refreshToken;
    user.activeSession = tokens.accessToken;
    await user.save();
    
    await AuditLog.create({ rollNo: cleanRoll, action: 'LOGIN', details: `Login from ${req.ip}` });
    
    res.json({ 
      message: 'Login successful!', 
      accessToken: tokens.accessToken, 
      refreshToken: tokens.refreshToken,
      user: { name: user.name, rollNo: user.rollNo, role: user.role, email: user.email, profilePic: user.profilePic || user.profilePicPath }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      const decoded = jwt.decode(token);
      if (decoded) {
        await User.findOneAndUpdate({ rollNo: decoded.rollNo }, { activeSession: null, refreshToken: null });
        await AuditLog.create({ rollNo: decoded.rollNo, action: 'LOGOUT', details: 'Logout' });
      }
    }
    res.json({ message: 'Logged out successfully!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Forgot Password (FIX #10) -----
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const parseResult = forgotPasswordSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { rollNo, email } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found!' });
    if (user.email !== email) return res.status(400).json({ error: 'Email does not match records!' });
    
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    
    const resetLink = `https://your-frontend.com/reset-password?token=${token}`;
    await sendEmail(email, '🔑 Password Reset - BM Group ERP', 
      `<h3>Reset Your Password</h3><p>Click the link below to reset your password (valid for 1 hour):</p><a href="${resetLink}">${resetLink}</a>`);
    
    res.json({ message: 'Password reset email sent!' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const parseResult = resetPasswordSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { token, newPassword } = parseResult.data;
    const user = await User.findOne({ 
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired token!' });
    
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();
    
    await sendEmail(user.email, '✅ Password Reset Successful', `<h3>Your password has been reset successfully.</h3>`);
    res.json({ message: 'Password reset successful!' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ----- Student Profile (UPDATED with file upload - FIX #4 & #23) -----
app.get('/api/student/profile/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll }).select('-password -activeSession -refreshToken -resetPasswordToken -resetPasswordExpires');
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/student/profile', async (req, res) => {
  try {
    const { rollNo, email, phone, semester, branch } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (semester) user.semester = semester;
    if (branch) user.branch = branch;
    await user.save();
    await AuditLog.create({ rollNo: cleanRoll, action: 'PROFILE_UPDATE', details: 'Profile updated' });
    res.json({ message: 'Profile updated successfully!', user: { name: user.name, rollNo: user.rollNo, email: user.email, phone: user.phone, semester: user.semester, branch: user.branch, profilePic: user.profilePic || user.profilePicPath } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/student/profile-pic', upload.single('profilePic'), async (req, res) => {
  try {
    const { rollNo } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    // Delete old pic if exists
    if (user.profilePicPath) {
      const oldPath = path.join(__dirname, user.profilePicPath);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const filePath = `uploads/${req.file.filename}`;
    user.profilePicPath = filePath;
    user.profilePic = `/api/student/profile-pic/${req.file.filename}`;
    await user.save();
    res.json({ message: 'Profile picture updated!', profilePic: user.profilePic });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/profile-pic/:filename', (req, res) => {
  const filePath = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// ----- Admin Routes -----
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo, newPassword } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const hashedPassword = await bcrypt.hash(newPassword || '123456', 10);
    const updated = await User.findOneAndUpdate({ rollNo: cleanRoll }, { password: hashedPassword });
    if (!updated) return res.status(404).json({ error: 'Student Roll No not found!' });
    await AuditLog.create({ rollNo: cleanRoll, action: 'PASSWORD_RESET', details: `Reset by ${requesterRollNo}` });
    res.json({ message: `Password reset for ${cleanRoll}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: `Student ${cleanRoll} not found!` });
    user.boundDeviceId = null;
    await user.save();
    await AuditLog.create({ rollNo: cleanRoll, action: 'DEVICE_RESET', details: `Reset by ${requesterRollNo}` });
    res.json({ message: `✅ Device binding reset for ${cleanRoll}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/update-rollno', async (req, res) => {
  try {
    const { requesterRollNo, oldRoll, newRoll } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanOld = oldRoll.trim().toUpperCase();
    const cleanNew = newRoll.trim().toUpperCase();
    await User.findOneAndUpdate({ rollNo: cleanOld }, { rollNo: cleanNew });
    await Attendance.updateMany({ rollNo: cleanOld }, { rollNo: cleanNew });
    await AuditLog.create({ rollNo: cleanNew, action: 'ROLL_UPDATE', details: `Updated from ${cleanOld} to ${cleanNew}` });
    res.json({ message: `Roll Number updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/delete-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTarget = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanTarget });
    if (user && user.profilePicPath) {
      const oldPath = path.join(__dirname, user.profilePicPath);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await User.findOneAndDelete({ rollNo: cleanTarget });
    await Attendance.deleteMany({ rollNo: cleanTarget });
    await AuditLog.create({ rollNo: cleanTarget, action: 'ACCOUNT_DELETED', details: `Deleted by ${requesterRollNo}` });
    res.json({ message: `Account and records deleted for ${cleanTarget}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Bulk Import Students (FIX #11) -----
app.post('/api/admin/bulk-import', async (req, res) => {
  try {
    const { requesterRollNo, students } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'Students array required' });
    }
    let imported = 0, failed = 0, errors = [];
    for (const s of students) {
      try {
        const cleanRoll = s.rollNo.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!/^\d{2}(CSE|AIDS)\d{2}$/.test(cleanRoll)) {
          failed++; errors.push(`Invalid roll: ${s.rollNo}`);
          continue;
        }
        const exists = await User.findOne({ rollNo: cleanRoll });
        if (exists) { failed++; errors.push(`Already exists: ${cleanRoll}`); continue; }
        const hashedPassword = await bcrypt.hash(s.password || '123456', 10);
        await new User({ name: s.name, rollNo: cleanRoll, password: hashedPassword, role: s.role || 'student', email: s.email || null, phone: s.phone || null, semester: s.semester || '5th', branch: s.branch || 'CSE' }).save();
        imported++;
      } catch(e) { failed++; errors.push(e.message); }
    }
    await AuditLog.create({ rollNo: requesterRollNo, action: 'BULK_IMPORT', details: `Imported ${imported}, Failed ${failed}` });
    res.json({ message: `Imported ${imported} students, Failed ${failed}`, imported, failed, errors });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ----- Passcode Routes -----
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    await Passcode.deleteMany({});
    const passcode = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await Passcode.create({ passcode, expiresAt });
    res.json({ message: 'Passcode generated!', passcode, expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/verify-passcode', async (req, res) => {
  try {
    const { passcode } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Passcode required!' });
    const record = await Passcode.findOne({ passcode });
    if (!record) return res.status(400).json({ error: 'Invalid passcode!' });
    if (record.expiresAt < new Date()) {
      await Passcode.deleteOne({ _id: record._id });
      return res.status(400).json({ error: 'Passcode expired! Please refresh.' });
    }
    res.json({ message: 'Passcode verified!', verified: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Notices (FIX #18 - Target roles) -----
app.get('/api/notices', async (req, res) => {
  try {
    const { role } = req.query;
    const filter = role ? { $or: [{ target: 'all' }, { target: role }] } : {};
    const notices = await Notice.find(filter).sort({ date: -1 }).limit(10);
    res.json(notices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message, target } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!message || message.trim() === "") {
      await Notice.deleteMany({});
      return res.json({ message: 'Notices cleared!' });
    }
    const newNotice = await new Notice({ title: title || 'Announcement', message, target: target || 'all' }).save();
    // Send email to all students (FIX #16)
    if (transporter) {
      const students = await User.find({ role: 'student', email: { $ne: null } }).select('email');
      for (const s of students) {
        try {
          await sendEmail(s.email, `📢 ${title || 'Announcement'}`, `<h3>${title || 'Announcement'}</h3><p>${message}</p><p>From: BM Group ERP</p>`);
        } catch(e) {}
      }
    }
    res.status(201).json({ message: 'Notice published!', notice: newNotice });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Holiday Routes -----
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const parts = date.split('-');
    const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dateObj < SEMESTER_START) return res.status(400).json({ error: 'Cannot declare holiday before 15 July 2026!' });
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[dateObj.getDay()];
    if (dayName === 'Saturday' || dayName === 'Sunday') return res.status(400).json({ error: 'Cannot declare holiday on weekend!' });
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'College Holiday' }, { upsert: true, new: true });
    await AuditLog.create({ rollNo: requesterRollNo, action: 'HOLIDAY_DECLARED', details: `${date}: ${reason}` });
    // Email alert (FIX #16)
    if (transporter) {
      const students = await User.find({ role: 'student', email: { $ne: null } }).select('email');
      for (const s of students) {
        try {
          await sendEmail(s.email, `🎉 Holiday Declared`, `<h3>Holiday Declared</h3><p>Date: ${date}</p><p>Reason: ${reason || 'College Holiday'}</p>`);
        } catch(e) {}
      }
    }
    res.json({ message: `✅ Holiday declared for ${date}: ${reason || 'College Holiday'}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/holidays', async (req, res) => {
  try {
    const holidays = await Holiday.find();
    res.json(holidays);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/date-status/:date', async (req, res) => {
  try {
    const status = await checkDateStatus(req.params.date);
    res.json(status);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Admin Dashboard Stats -----
app.get('/api/admin/dashboard-stats/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    
    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalFaculty = await User.countDocuments({ role: 'faculty' });
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    
    const todayPresentStudents = await Attendance.distinct('rollNo', { 
      date: todayDate, 
      status: 'Present',
      rollNo: { $nin: ADMIN_ROLL_NUMBERS } 
    });
    const todayPresent = todayPresentStudents.length;
    
    const presentStudentDetails = await Attendance.find({ 
      date: todayDate, 
      status: 'Present',
      rollNo: { $nin: ADMIN_ROLL_NUMBERS }
    }).select('rollNo studentName').lean();
    
    const uniquePresent = {};
    presentStudentDetails.forEach(s => {
      if (!uniquePresent[s.rollNo]) uniquePresent[s.rollNo] = { rollNo: s.rollNo, name: s.studentName };
    });
    const presentList = Object.values(uniquePresent);
    
    const allStudents = await User.find({ role: 'student' }).select('rollNo');
    const allRollNos = allStudents.map(s => s.rollNo);
    const presentRollNos = new Set(todayPresentStudents);
    const absentRollNos = allRollNos.filter(r => !presentRollNos.has(r));
    const todayAbsent = absentRollNos.length;
    
    const totalAttendance = await Attendance.countDocuments({ rollNo: { $nin: ADMIN_ROLL_NUMBERS } });
    const presentCount = await Attendance.countDocuments({ status: 'Present', rollNo: { $nin: ADMIN_ROLL_NUMBERS } });
    const overallPct = totalAttendance > 0 ? Math.round((presentCount / totalAttendance) * 100) : 0;
    
    // Subject-wise attendance for admin (FIX #13)
    const subjectStats = await Attendance.aggregate([
      { $match: { rollNo: { $nin: ADMIN_ROLL_NUMBERS } } },
      { $group: { _id: '$subject', total: { $sum: 1 }, present: { $sum: { $cond: [{ $eq: ['$status', 'Present'] }, 1, 0] } } } }
    ]);
    
    const semesterStartStr = SEMESTER_START.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const workingDaysSoFar = await getWorkingDays(semesterStartStr, todayStr);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStartStr, SEMESTER_END.toISOString().split('T')[0]);
    
    // Recent audit logs (FIX #17)
    const recentLogs = await AuditLog.find().sort({ timestamp: -1 }).limit(50);
    
    res.json({ 
      totalStudents, totalFaculty, todayPresent, todayAbsent, 
      overallAttendance: totalAttendance, overallPct, 
      todayPresentStudents: presentList,
      workingDaysSoFar, totalWorkingDaysSemester,
      subjectStats,
      recentLogs
    });
  } catch (err) { 
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: err.message }); 
  }
});

// ----- All Users (Students + Faculty) -----
app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const users = await User.find({ role: { $ne: 'admin' } }).select('name rollNo role boundDeviceId createdAt email phone semester branch profilePic').sort({ rollNo: 1 });
    const admin = await User.findOne({ rollNo: requesterRollNo }).select('name rollNo');
    if (admin) users.unshift({ ...admin._doc, role: 'admin' });
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Internal Messaging (FIX #18) -----
app.post('/api/messages/send', async (req, res) => {
  try {
    const { from, to, subject, message } = req.body;
    if (!from || !to || !message) return res.status(400).json({ error: 'From, To, and Message required' });
    const msg = await new Message({ from, to, subject, message }).save();
    // Send email notification (FIX #16)
    const receiver = await User.findOne({ rollNo: to });
    if (receiver && receiver.email && transporter) {
      await sendEmail(receiver.email, `📩 ${subject || 'New Message'}`, `<h3>New Message</h3><p>From: ${from}</p><p>${message}</p>`);
    }
    res.status(201).json({ message: 'Message sent!', msg });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/:rollNo', async (req, res) => {
  try {
    const messages = await Message.find({ 
      $or: [{ to: req.params.rollNo }, { from: req.params.rollNo }] 
    }).sort({ createdAt: -1 });
    res.json(messages);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/messages/:id/read', async (req, res) => {
  try {
    await Message.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ message: 'Marked as read' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ----- Leave Application (FIX #12) -----
app.post('/api/attendance/leave-request', async (req, res) => {
  try {
    const { rollNo, date, subject, reason } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found!' });
    // Check if attendance exists for that date/subject
    const record = await Attendance.findOne({ rollNo: cleanRoll, date, subject });
    if (record) {
      record.status = 'Leave Requested';
      record.leaveReason = reason;
      await record.save();
    } else {
      await new Attendance({
        rollNo: cleanRoll,
        studentName: user.name,
        subject,
        date,
        status: 'Leave Requested',
        leaveReason: reason,
        isVerified: false,
        markedBy: 'student'
      }).save();
    }
    // Notify admin via email (FIX #16)
    if (transporter) {
      const admin = await User.findOne({ rollNo: ADMIN_ROLL_NUMBERS[0] });
      if (admin && admin.email) {
        await sendEmail(admin.email, `📋 Leave Request from ${cleanRoll}`, 
          `<h3>Leave Request</h3><p>Student: ${user.name} (${cleanRoll})</p><p>Date: ${date}</p><p>Subject: ${subject}</p><p>Reason: ${reason}</p>`);
      }
    }
    res.json({ message: 'Leave request submitted!' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/leave-action', async (req, res) => {
  try {
    const { requesterRollNo, rollNo, date, subject, action } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const record = await Attendance.findOne({ rollNo: rollNo.trim().toUpperCase(), date, subject });
    if (!record) return res.status(404).json({ error: 'Record not found!' });
    const newStatus = action === 'approve' ? 'Leave Approved' : 'Leave Rejected';
    record.correctionLog.push({
      changedBy: requesterRollNo,
      oldStatus: record.status,
      newStatus: newStatus,
      reason: action === 'approve' ? 'Approved by admin' : 'Rejected by admin'
    });
    record.status = newStatus;
    await record.save();
    // Notify student via email (FIX #16)
    const student = await User.findOne({ rollNo: rollNo.trim().toUpperCase() });
    if (student && student.email && transporter) {
      await sendEmail(student.email, `📋 Leave ${action === 'approve' ? 'Approved' : 'Rejected'}`, 
        `<h3>Leave ${action === 'approve' ? 'Approved' : 'Rejected'}</h3><p>Date: ${date}</p><p>Subject: ${subject}</p>`);
    }
    res.json({ message: `Leave ${action}ed successfully` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ----- Attendance Marking (UPDATED) -----
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll);
      return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    }
    
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    
    const isLab = subject.includes("LAB") || subject.includes("Lab");
    const todayEntries = await Attendance.find({ rollNo: cleanRoll, subject, date: todayDate });
    if (isLab && todayEntries.length >= 1) return res.status(400).json({ error: `Already marked for ${subject} today! (Lab - 1 lecture only)` });
    
    user.failedAttempts = 0;
    user.blockUntil = null;
    
    const record = new Attendance({
      rollNo: cleanRoll,
      studentName: name,
      subject,
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude },
      ipAddress: req.ip,
      isVerified: true,
      markedBy: 'student',
      correctionLog: [{ changedBy: 'system', oldStatus: 'Absent', newStatus: 'Present', reason: 'Auto-marked' }]
    });
    await record.save();
    
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();
    
    await AuditLog.create({ rollNo: cleanRoll, action: 'ATTENDANCE_MARKED', details: `${subject} on ${todayDate}` });
    
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) { 
    console.error('Attendance error:', err);
    res.status(500).json({ error: err.message }); 
  }
});

// ----- Full Day Attendance (skip Library) -----
app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll);
      return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    }
    
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];
    const allSubjects = TIME_TABLE[dayName] || ['General Class'];
    const academicSubjects = allSubjects.filter(sub => !sub.includes("LIB") && !sub.includes("Library") && !sub.includes("Sports"));
    
    let markedCount = 0;
    for (let sub of academicSubjects) {
      const exists = await Attendance.findOne({ rollNo: cleanRoll, subject: sub, date: todayDate });
      if (!exists) {
        await new Attendance({
          rollNo: cleanRoll,
          studentName: name,
          subject: sub,
          date: todayDate,
          status: 'Present',
          location: { latitude, longitude },
          ipAddress: req.ip,
          isVerified: true,
          markedBy: 'student'
        }).save();
        markedCount++;
      }
    }
    
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
    
    if (markedCount === 0) return res.status(400).json({ error: 'All academic subjects already marked!' });
    await AuditLog.create({ rollNo: cleanRoll, action: 'FULL_DAY_MARKED', details: `${markedCount} lectures on ${todayDate}` });
    res.status(201).json({ message: `✅ Full Day Marked (${markedCount} academic Lectures)!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Admin Manual Attendance -----
app.post('/api/admin/manual-attendance-bulk', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, subjects, status } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    
    const parts = date.split('-');
    const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dateObj < SEMESTER_START) return res.status(400).json({ error: 'Cannot mark before 15 July 2026!' });
    
    const dateStatus = await checkDateStatus(date);
    if (dateStatus.isBlocked) return res.status(400).json({ error: `Cannot mark on ${dateStatus.type}` });
    
    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });
    
    let markedCount = 0;
    for (let sub of subjects) {
      const exists = await Attendance.findOne({ rollNo: targetRoll, subject: sub, date });
      if (!exists) {
        const record = new Attendance({
          rollNo: targetRoll,
          studentName: user.name,
          subject: sub,
          date,
          status: status || 'Present',
          location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
          ipAddress: 'admin-manual',
          isVerified: true,
          markedBy: 'admin',
          correctionLog: [{ changedBy: requesterRollNo, oldStatus: 'Absent', newStatus: status || 'Present', reason: 'Admin manual mark' }]
        });
        await record.save();
        markedCount++;
      }
    }
    await AuditLog.create({ rollNo: targetRoll, action: 'MANUAL_ATTENDANCE', details: `${markedCount} lectures on ${date} by ${requesterRollNo}` });
    res.status(201).json({ message: `✅ Marked ${markedCount} lectures for ${user.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- History & Analytics -----
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const history = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(allRecords);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Subject-wise Analytics (FIX #13) -----
app.get('/api/analytics/subject/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const records = await Attendance.find({ rollNo: cleanRoll });
    const allSubjects = [
      'BDA - Big Data Analytics', 'ECO - Economics for Engineers',
      'DAA - Design & Analysis of Algorithm', 'FLA - Formal Language & Automata',
      'HRM - Human Resource Mgmt', 'CN - Computer Network',
      'WT - Web Technology', 'CN LAB - Computer Network Lab',
      'DAA LAB - Algorithm Lab', 'WT LAB - Web Technology Lab',
      'Internet Lab (Ms. Geeta)', 'LIB - Library'
    ];
    let subjectStats = {};
    allSubjects.forEach(sub => { subjectStats[sub] = { present: 0, total: 0, percentage: 0 }; });
    records.forEach(rec => {
      if (subjectStats[rec.subject]) {
        subjectStats[rec.subject].total += 1;
        if (rec.status === 'Present' || rec.status === 'Leave Approved' || rec.status === 'Duty Leave') {
          subjectStats[rec.subject].present += 1;
        }
      }
    });
    // Calculate percentages
    Object.keys(subjectStats).forEach(key => {
      const s = subjectStats[key];
      s.percentage = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
    });
    res.json(subjectStats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Exports (FIX #15 - PDF) -----
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csv = 'Roll No,Student Name,Subject,Date,Status,IP Address,Location\n';
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csv += `${r.rollNo},${r.studentName},${r.subject},${r.date},${r.status},${r.ipAddress || 'N/A'},${loc}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Single Student Export -----
app.get('/api/export/student-attendance/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const { studentRollNo, range, month } = req.query;
    if (!studentRollNo) return res.status(400).json({ error: 'studentRollNo required' });
    const cleanStudent = studentRollNo.trim().toUpperCase();
    const today = new Date();
    let startDate, endDate;
    if (range === 'CURRENT_MONTH') {
      startDate = new Date(today.getFullYear(), today.getMonth(), 1);
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else if (range === 'SELECTED_MONTH') {
      const m = parseInt(month);
      if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' });
      startDate = new Date(2026, m, 1);
      endDate = new Date(2026, m + 1, 0);
    } else {
      startDate = new Date(SEMESTER_START);
      endDate = new Date(SEMESTER_END);
    }
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const records = await Attendance.find({ rollNo: cleanStudent, date: { $gte: startStr, $lte: endStr } }).sort({ date: 1 });
    if (records.length === 0) return res.status(404).json({ error: 'No records found' });
    const studentName = records[0].studentName || 'Unknown';
    let csv = `Student Attendance Report\nStudent: ${studentName} (${cleanStudent})\nRange: ${startStr} to ${endStr}\n\nDate,Subject,Status,Location,IP Address\n`;
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csv += `${r.date},${r.subject},${r.status},${loc},${r.ipAddress || 'N/A'}\n`;
    });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Leave Approved' || r.status === 'Duty Leave').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csv += `\nTotal: ${total}, Present: ${present}, Attendance: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cleanStudent}_${range}.csv`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Audit Logs (FIX #17) -----
app.get('/api/admin/audit-logs/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const { limit = 100, rollNo } = req.query;
    const filter = rollNo ? { rollNo } : {};
    const logs = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(parseInt(limit));
    res.json(logs);
  } catch(err) { res.status(500).json({ error: err.message }); }
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
