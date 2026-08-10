const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone set to: ${process.env.TZ}`);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ---------- Environment Variables ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const ADMIN_ROLL_NUMBERS = ['24CSE48'];
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 50;
const SEMESTER_START = new Date(2026, 6, 15); // 15 July 2026
const SEMESTER_END = new Date(2026, 11, 31); // 31 Dec 2026

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
  deviceId: z.string().optional()
});

const loginSchema = z.object({
  rollNo: z.string().min(1, "Roll No required"),
  password: z.string().min(1, "Password required"),
  deviceId: z.string().optional()
});

// ---------- Timetable (Monday last = LIB - Library) ----------
const TIME_TABLE = {
  Monday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'DAA - Design & Analysis of Algorithm', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'CN - Computer Network', 'LIB - Library'],
  Tuesday: ['WT - Web Technology', 'ECO - Economics for Engineers', 'Internet Lab (Ms. Geeta)', 'FLA - Formal Language & Automata', 'HRM - Human Resource Mgmt', 'BDA - Big Data Analytics'],
  Wednesday: ['BDA - Big Data Analytics', 'ECO - Economics for Engineers', 'FLA - Formal Language & Automata', 'WT - Web Technology', 'CN LAB - Computer Network Lab'],
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
  boundDeviceId: { type: String, default: null },
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  failedAttempts: { type: Number, default: 0 },
  blockUntil: { type: Date, default: null },
  email: { type: String, default: null },
  profilePic: { type: String, default: null },
  semester: { type: String, default: '5th' },
  branch: { type: String, default: 'CSE' },
  activeSession: { type: String, default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
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

const passcodeSchema = new mongoose.Schema({
  passcode: { type: String, required: true, unique: true },
  type: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);

// ---------- Helper: Check if date is holiday or weekend ----------
async function checkDateStatus(dateStr) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const parts = dateStr.split('-');
  const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayName = days[dateObj.getDay()];
  
  if (dayName === 'Saturday' || dayName === 'Sunday') {
    return { 
      isBlocked: true, 
      type: 'WEEKEND',
      message: `📅 ${dayName}: College Closed (Weekend)`,
      dayName 
    };
  }
  
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    return { 
      isBlocked: true, 
      type: 'HOLIDAY',
      message: `🎉 Holiday: ${holiday.reason}`,
      dayName,
      holiday: holiday.reason
    };
  }
  
  return { isBlocked: false, dayName };
}

// ---------- Helper: Get Working Days (excluding weekends & holidays) ----------
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
    console.log(`🚫 ${rollNo} blocked for 1 hour`);
  }
  await user.save();
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

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));

// ----- Auth Routes -----
app.post('/api/auth/register', async (req, res) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { name, rollNo, password, deviceId } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'Roll number already registered!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : 'student';
    await new User({ name, rollNo: cleanRoll, password: hashedPassword, role, boundDeviceId: deviceId || null }).save();
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
    
    // Device binding ONLY for students, NOT for admin
    const isAdmin = ADMIN_ROLL_NUMBERS.includes(cleanRoll);
    
    if (!isAdmin && user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { 
        user.boundDeviceId = deviceId; 
        await user.save(); 
      }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
      }
    }
    // Admin and faculty can login from any device
    
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token;
    await user.save();
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      const decoded = jwt.decode(token);
      if (decoded) await User.findOneAndUpdate({ rollNo: decoded.rollNo }, { activeSession: null });
    }
    res.json({ message: 'Logged out successfully!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Student Profile -----
app.post('/api/student/profile', async (req, res) => {
  try {
    const { rollNo, email, phone, profilePic, semester, branch } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (profilePic) user.profilePic = profilePic;
    if (semester) user.semester = semester;
    if (branch) user.branch = branch;
    await user.save();
    res.json({ message: 'Profile updated successfully!', user: { name: user.name, rollNo: user.rollNo, email: user.email, phone: user.phone, semester: user.semester, branch: user.branch, profilePic: user.profilePic } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/student/profile/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll }).select('-password -activeSession');
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.json({ message: `Roll Number updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/delete-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTarget = targetRollNo.trim().toUpperCase();
    await User.findOneAndDelete({ rollNo: cleanTarget });
    await Attendance.deleteMany({ rollNo: cleanTarget });
    res.json({ message: `Account and records deleted for ${cleanTarget}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Admin Login as Student (NEW) -----
app.post('/api/admin/login-as-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanTarget = targetRollNo.trim().toUpperCase();
    const student = await User.findOne({ rollNo: cleanTarget });
    if (!student) return res.status(404).json({ error: 'Student not found!' });
    // Generate a token for the student (role = student)
    const token = jwt.sign({ id: student._id, rollNo: student.rollNo, name: student.name, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
    // Log the action
    console.log(`🔑 Admin ${requesterRollNo} logged in as ${cleanTarget}`);
    res.json({ 
      message: `Logged in as ${student.name}`, 
      token, 
      user: { name: student.name, rollNo: student.rollNo, role: 'student' },
      isImpersonating: true,
      adminRoll: requesterRollNo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Passcode Routes (UPDATED for two types) -----
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) {
      return res.status(400).json({ error: 'Invalid passcode type. Use "full_day" or "single_lecture".' });
    }
    // Delete old passcodes of the same type
    await Passcode.deleteMany({ type });
    const length = type === 'full_day' ? 5 : 4;
    const passcode = Math.floor(Math.pow(10, length-1) + Math.random() * (Math.pow(10, length) - Math.pow(10, length-1))).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await Passcode.create({ passcode, type, expiresAt });
    res.json({ message: `Passcode generated for ${type}`, passcode, type, expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/verify-passcode', async (req, res) => {
  try {
    const { passcode, type } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Passcode required!' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) {
      return res.status(400).json({ error: 'Invalid passcode type.' });
    }
    const record = await Passcode.findOne({ passcode, type });
    if (!record) {
      return res.status(400).json({ error: 'Invalid passcode!' });
    }
    if (record.expiresAt < new Date()) {
      await Passcode.deleteOne({ _id: record._id });
      return res.status(400).json({ error: 'Passcode expired! Please refresh.' });
    }
    res.json({ message: 'Passcode verified!', verified: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Notices -----
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 }).limit(10);
    res.json(notices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!message || message.trim() === "") {
      await Notice.deleteMany({});
      return res.json({ message: 'Notices cleared!' });
    }
    const newNotice = await new Notice({ title: title || 'Announcement', message }).save();
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
    if (dateObj < SEMESTER_START) {
      return res.status(400).json({ error: 'Cannot declare holiday before 15 July 2026!' });
    }
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[dateObj.getDay()];
    if (dayName === 'Saturday' || dayName === 'Sunday') {
      return res.status(400).json({ error: 'Cannot declare holiday on weekend (Saturday/Sunday)!' });
    }
    
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'College Holiday' }, { upsert: true, new: true });
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
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    console.log(`📊 Dashboard stats for ${todayDate}`);
    
    const todayPresentStudents = await Attendance.distinct('rollNo', { date: todayDate, status: 'Present' });
    const todayPresent = todayPresentStudents.length;
    
    const presentStudentDetails = await Attendance.find({ date: todayDate, status: 'Present' })
      .select('rollNo studentName')
      .lean();
    const uniquePresent = {};
    presentStudentDetails.forEach(s => {
      if (!uniquePresent[s.rollNo]) {
        uniquePresent[s.rollNo] = { rollNo: s.rollNo, name: s.studentName };
      }
    });
    const presentList = Object.values(uniquePresent);
    
    const allStudents = await User.find({ role: 'student' }).select('rollNo');
    const allRollNos = allStudents.map(s => s.rollNo);
    const presentRollNos = new Set(todayPresentStudents);
    const absentRollNos = allRollNos.filter(r => !presentRollNos.has(r));
    const todayAbsent = absentRollNos.length;
    
    const totalAttendance = await Attendance.countDocuments();
    const presentCount = await Attendance.countDocuments({ status: 'Present' });
    const overallPct = totalAttendance > 0 ? Math.round((presentCount / totalAttendance) * 100) : 0;
    
    const semesterStartStr = SEMESTER_START.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const workingDaysSoFar = await getWorkingDays(semesterStartStr, todayStr);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStartStr, SEMESTER_END.toISOString().split('T')[0]);
    
    console.log(`Working days so far: ${workingDaysSoFar}, total: ${totalWorkingDaysSemester}`);
    
    res.json({ 
      totalStudents, 
      todayPresent, 
      todayAbsent, 
      overallAttendance: totalAttendance, 
      overallPct, 
      todayPresentStudents: presentList,
      workingDaysSoFar,
      totalWorkingDaysSemester
    });
  } catch (err) { 
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: err.message }); 
  }
});

// ----- All Students for Admin (including admin himself for export) -----
app.get('/api/admin/all-students/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const students = await User.find({ role: 'student' }).select('name rollNo role boundDeviceId createdAt email phone semester branch profilePic').sort({ rollNo: 1 });
    const admin = await User.findOne({ rollNo: requesterRollNo }).select('name rollNo');
    if (admin) {
      students.unshift({ ...admin._doc, role: 'admin' });
    }
    res.json(students);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Attendance Marking -----
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) {
      return res.status(400).json({ error: dateStatus.message });
    }
    
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
    
    await new Attendance({
      rollNo: cleanRoll,
      studentName: name,
      subject,
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude },
      ipAddress: req.ip,
      isVerified: true
    }).save();
    
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();
    
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) { 
    console.error('Attendance error:', err);
    res.status(500).json({ error: err.message }); 
  }
});

// ----- Full Day Attendance (skip Library, Sports) -----
app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) {
      return res.status(400).json({ error: dateStatus.message });
    }
    
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
    
    const academicSubjects = allSubjects.filter(sub => 
      !sub.includes("LIB") && !sub.includes("Library") && !sub.includes("Sports")
    );
    
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
          isVerified: true
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
    if (dateObj < SEMESTER_START) {
      return res.status(400).json({ error: 'Cannot mark attendance before 15 July 2026! College was closed.' });
    }
    
    const dateStatus = await checkDateStatus(date);
    if (dateStatus.isBlocked) {
      return res.status(400).json({ error: `Cannot mark attendance on ${dateStatus.type}: ${dateStatus.message}` });
    }
    
    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });
    
    let markedCount = 0;
    const markedSubjects = [];
    const alreadyMarked = [];
    
    for (let sub of subjects) {
      const exists = await Attendance.findOne({ rollNo: targetRoll, subject: sub, date });
      if (!exists) {
        await new Attendance({
          rollNo: targetRoll,
          studentName: user.name,
          subject: sub,
          date,
          status: status || 'Present',
          location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
          ipAddress: 'admin-manual',
          isVerified: true
        }).save();
        markedCount++;
        markedSubjects.push(sub);
      } else {
        alreadyMarked.push(sub);
      }
    }
    
    let message = `✅ Marked ${markedCount} lectures for ${user.name} on ${date}`;
    if (alreadyMarked.length > 0) message += `. Already marked: ${alreadyMarked.join(', ')}`;
    res.status(201).json({ message, markedSubjects, alreadyMarked, total: markedCount });
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

app.get('/api/analytics/:rollNo', async (req, res) => {
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
    allSubjects.forEach(sub => { subjectStats[sub] = { present: 0, total: 0 }; });
    records.forEach(rec => {
      if (subjectStats[rec.subject]) {
        subjectStats[rec.subject].total += 1;
        if (rec.status === 'Present') subjectStats[rec.subject].present += 1;
      }
    });
    res.json(subjectStats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ====== 🆕 OPTIMIZED STUDENT SUMMARY ROUTE ======
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    // Get all attendance records for this student
    const allRecords = await Attendance.find({ rollNo: cleanRoll }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date));

    // Compute total conducted academic subjects and days
    const today = new Date();
    const semesterStart = new Date(2026, 6, 15);
    let current = new Date(semesterStart);
    let totalConductedAcademicSubjects = 0;
    const academicDaysSet = new Set();
    const subjectStats = {};

    // Precompute subject counts per day from timetable (to avoid repeated lookups)
    const dayNameMap = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayAcademicSubjects = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subjects = TIME_TABLE[dayName] || [];
      const academic = subjects.filter(sub => !sub.includes("LIB") && !sub.includes("Library") && !sub.includes("Sports"));
      dayAcademicSubjects[dayName] = academic;
    }

    while (current <= today) {
      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const isHoliday = holidaySet.has(dateStr);

      if (!isWeekend && !isHoliday) {
        academicDaysSet.add(dateStr);
        const dayName = dayNameMap[dayOfWeek];
        const academicSubjects = dayAcademicSubjects[dayName] || [];
        totalConductedAcademicSubjects += academicSubjects.length;

        // Initialize subjectStats for subjects not seen yet
        academicSubjects.forEach(sub => {
          if (!subjectStats[sub]) {
            subjectStats[sub] = { total: 0, present: 0 };
          }
          subjectStats[sub].total = (subjectStats[sub].total || 0) + 1;
        });
      }
      current.setDate(current.getDate() + 1);
    }

    // Now process all attendance records to count present per subject and days present
    const presentDaysSet = new Set();
    const subjectPresentCount = {};

    allRecords.forEach(rec => {
      const sub = rec.subject;
      // Only count academic subjects (exclude library, sports)
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        if (!subjectPresentCount[sub]) subjectPresentCount[sub] = 0;
        subjectPresentCount[sub] = (subjectPresentCount[sub] || 0) + 1;
        presentDaysSet.add(rec.date);
      }
    });

    // Update subjectStats with present counts
    Object.keys(subjectPresentCount).forEach(sub => {
      if (subjectStats[sub]) {
        subjectStats[sub].present = subjectPresentCount[sub];
      }
    });

    // Calculate total academic lectures attended (sum of present counts)
    let totalAcademicLecturesAttended = 0;
    Object.values(subjectPresentCount).forEach(v => totalAcademicLecturesAttended += v);

    const pct = totalConductedAcademicSubjects > 0 
      ? Math.round((totalAcademicLecturesAttended / totalConductedAcademicSubjects) * 100) 
      : 0;

    const daysPresent = presentDaysSet.size;
    const totalWorkingDays = academicDaysSet.size;
    const daysAbsent = totalWorkingDays - daysPresent;

    // Subject-wise percentages
    const subjectStatsFinal = {};
    for (let [sub, stats] of Object.entries(subjectStats)) {
      subjectStatsFinal[sub] = {
        present: stats.present || 0,
        total: stats.total || 0,
        percentage: stats.total > 0 ? Math.round(((stats.present || 0) / stats.total) * 100) : 0
      };
    }

    res.json({
      totalAcademicLectures: totalAcademicLecturesAttended,
      totalConductedLectures: totalConductedAcademicSubjects,
      attendancePercentage: pct,
      daysPresent,
      daysAbsent,
      workingDaysSoFar: totalWorkingDays,
      subjectStats: subjectStatsFinal
    });

  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----- Export Routes -----
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

app.get('/api/export/student-attendance/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }

    const { studentRollNo, range, month } = req.query;
    if (!studentRollNo) {
      return res.status(400).json({ error: 'studentRollNo is required' });
    }

    const cleanStudent = studentRollNo.trim().toUpperCase();
    const today = new Date();
    let startDate, endDate;

    if (range === 'CURRENT_MONTH') {
      startDate = new Date(today.getFullYear(), today.getMonth(), 1);
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else if (range === 'SELECTED_MONTH') {
      const m = parseInt(month);
      if (isNaN(m) || m < 0 || m > 11) {
        return res.status(400).json({ error: 'Invalid month' });
      }
      startDate = new Date(2026, m, 1);
      endDate = new Date(2026, m + 1, 0);
    } else { // FULL_SEMESTER
      startDate = new Date(SEMESTER_START);
      endDate = new Date(SEMESTER_END);
    }

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const records = await Attendance.find({
      rollNo: cleanStudent,
      date: { $gte: startStr, $lte: endStr }
    }).sort({ date: 1 });

    if (records.length === 0) {
      return res.status(404).json({ error: 'No records found for this student in the selected range.' });
    }

    const studentName = records[0].studentName || 'Unknown';

    let csv = `Student Attendance Report\n`;
    csv += `Student: ${studentName} (${cleanStudent})\n`;
    csv += `Range: ${startStr} to ${endStr}\n`;
    csv += `Generated: ${new Date().toLocaleString()}\n\n`;
    csv += 'Date,Subject,Status,Location,IP Address\n';

    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csv += `${r.date},${r.subject},${r.status},${loc},${r.ipAddress || 'N/A'}\n`;
    });

    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csv += `\nTotal Lectures: ${total}, Present: ${present}, Attendance %: ${pct}%\n`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cleanStudent}_${range}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Student export error:', err);
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
