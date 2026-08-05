const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const app = express();
app.use(express.json());
app.use(cors());

// ---------- Environment Variables ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const ADMIN_ROLL_NUMBERS = ['24CSE48'];

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI environment variable is not set!');
  process.exit(1);
}

// ---------- Rate Limiting (Brute Force Protection) ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minutes
  max: 10,
  message: { error: 'Too many attempts from this IP, please try again after 15 minutes.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down.' }
});

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// ---------- Zod Validation Schemas ----------
const registerSchema = z.object({
  name: z.string().min(2, "Name too short").max(50),
  rollNo: z.string().regex(/^\d{2}(CSE|AIDS)\d{2}$/, "Invalid Roll No format (e.g. 24CSE48)"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  deviceId: z.string().optional()
});

const loginSchema = z.object({
  rollNo: z.string().min(1, "Roll No required"),
  password: z.string().min(1, "Password required"),
  deviceId: z.string().optional()
});

// ---------- Timetable (for full‑day marking) ----------
const TIME_TABLE = {
  Monday: ['BDA', 'ECO', 'DAA', 'FLA', 'HRM', 'CN', 'WT'],
  Tuesday: ['WT', 'ECO', 'Internet', 'FLA', 'HRM', 'BDA'],
  Wednesday: ['BDA', 'ECO', 'FLA', 'WT', 'CN LAB'],
  Thursday: ['BDA', 'CN', 'DAA', 'DAA LAB', 'HRM'],
  Friday: ['DAA', 'CN', 'FLA', 'BDA', 'WT LAB']
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
  role: { type: String, enum: ['student', 'faculty', 'admin'], default: 'student' },
  faceDescriptor: { type: [Number], default: [] },
  boundDeviceId: { type: String, default: null },
  // ANTI-FAKE GPS FIELDS
  lastKnownIP: { type: String, default: null },
  lastAttendanceTime: { type: Date, default: null },
  lastAttendanceLocation: { latitude: Number, longitude: Number },
  anomalyFlag: { type: Boolean, default: false }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null }
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

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);

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

// ANTI-FAKE GPS: Anomaly Detection
function detectAnomaly(user, lat, lng, reqIP) {
  const MIN_TIME_BETWEEN_ATTENDANCE = 10 * 60 * 1000; // 10 Minutes
  
  // Check 1: Different IP within short time
  if (user.lastKnownIP && user.lastKnownIP !== reqIP) {
    if (user.lastAttendanceTime) {
      const timeDiff = Date.now() - new Date(user.lastAttendanceTime).getTime();
      if (timeDiff < MIN_TIME_BETWEEN_ATTENDANCE) {
        return { 
          isAnomaly: true, 
          reason: `🚨 IP changed from ${user.lastKnownIP} to ${reqIP} within ${Math.round(timeDiff/60000)} minutes!` 
        };
      }
    }
  }
  
  // Check 2: Impossible travel distance within short time
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
          reason: `🚨 Impossible travel: ${Math.round(distance)}m in ${Math.round(timeDiff/60000)} minutes!` 
        };
      }
    }
  }
  
  return { isAnomaly: false };
}

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active & Secured!'));

// ----- Auth (with Device Binding) -----
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

    res.status(201).json({ message: 'Registration successful!' });
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
    
    console.log(`📱 Login attempt for ${rollNo}, Device ID: ${deviceId || 'NOT PROVIDED'}`);
    
    const cleanRoll = rollNo.trim().toUpperCase();
    
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });

    // Device Binding Check
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) {
        user.boundDeviceId = deviceId;
        await user.save();
        console.log(`🔗 Device bound for ${cleanRoll}: ${deviceId}`);
      } else if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        console.log(`🚫 Device mismatch for ${cleanRoll}! Bound: ${user.boundDeviceId}, Attempt: ${deviceId}`);
        return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
      }
    }

    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : user.role;
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role } });
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
    res.json({ message: 'Face ID Enrolled & Synced Globally to MongoDB!' });
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
    res.json({ message: `Password reset successfully for ${cleanRoll}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Reset Device Binding API
app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    
    if (!user) {
      return res.status(404).json({ error: `Student ${cleanRoll} not found!` });
    }
    
    const oldDeviceId = user.boundDeviceId;
    user.boundDeviceId = null;
    await user.save();
    
    console.log(`🔓 Device binding reset for ${cleanRoll}! Old: ${oldDeviceId}, New: null`);
    
    res.json({ 
      message: `✅ Device binding reset for ${cleanRoll}! Now they can login from any phone.`,
      rollNo: cleanRoll,
      previousDeviceId: oldDeviceId || 'None'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Reset Anomaly Flag
app.post('/api/admin/reset-anomaly', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    
    if (!user) {
      return res.status(404).json({ error: `Student ${cleanRoll} not found!` });
    }
    
    user.anomalyFlag = false;
    user.lastKnownIP = null;
    user.lastAttendanceTime = null;
    user.lastAttendanceLocation = {};
    await user.save();
    
    console.log(`✅ Anomaly flag reset for ${cleanRoll}`);
    
    res.json({ 
      message: `✅ Anomaly flag reset for ${cleanRoll}! They can now mark attendance.`
    });
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

    res.json({ message: `Account and attendance records deleted for ${cleanTarget}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/faculty/override', verifyRole(['faculty', 'admin']), async (req, res) => {
  try {
    const { studentRollNo, subject, date, status } = req.body;
    await Attendance.findOneAndUpdate(
      { rollNo: studentRollNo, subject, date },
      { status },
      { new: true, upsert: true }
    );
    res.json({ message: "Attendance updated successfully" });
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
      return res.json({ message: 'All Active Notices Cleared Permanently!' });
    }

    await Notice.deleteMany({});
    await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Broadcast Notice Published!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Geofencing (50m radius) -----
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
// ----- Attendance Marking (with Anti-Fake GPS Protection) -----
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date(), todayDate = today.toISOString().split('T')[0];

    if (today.getDay() === 0 || today.getDay() === 6) {
      return res.status(400).json({ error: 'Weekend! College was OFF.' });
    }

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) {
      return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });
    }

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });
    }

    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) {
      return res.status(404).json({ error: 'Student not found!' });
    }

    // ANTI-FAKE GPS: Get Client IP
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    
    // ANTI-FAKE GPS: Anomaly Detection
    const anomaly = detectAnomaly(user, latitude, longitude, clientIP);
    
    if (anomaly.isAnomaly) {
      user.anomalyFlag = true;
      await user.save();
      
      console.log(`🚨 ANOMALY DETECTED for ${cleanRoll}: ${anomaly.reason}`);
      
      return res.status(403).json({ 
        error: '⛔ Attendance Blocked! Suspicious activity detected. Contact Admin.',
        reason: anomaly.reason 
      });
    }

    const exists = await Attendance.findOne({ rollNo: cleanRoll, subject, date: todayDate });
    if (exists) {
      return res.status(400).json({ error: `Already marked for ${subject} today!` });
    }

    user.lastKnownIP = clientIP;
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();

    await new Attendance({ 
      rollNo: cleanRoll, 
      studentName: name, 
      subject, 
      date: todayDate, 
      status: 'Present', 
      location: { latitude, longitude },
      ipAddress: clientIP 
    }).save();
    
    res.status(201).json({ message: `Attendance Marked for ${subject}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;
    const today = new Date(), todayDate = today.toISOString().split('T')[0];
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') {
      return res.status(400).json({ error: 'Weekend! College was OFF.' });
    }

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) {
      return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });
    }

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });
    }

    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) {
      return res.status(404).json({ error: 'Student not found!' });
    }

    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    
    const anomaly = detectAnomaly(user, latitude, longitude, clientIP);
    
    if (anomaly.isAnomaly) {
      user.anomalyFlag = true;
      await user.save();
      
      console.log(`🚨 ANOMALY DETECTED for ${cleanRoll}: ${anomaly.reason}`);
      
      return res.status(403).json({ 
        error: '⛔ Attendance Blocked! Suspicious activity detected. Contact Admin.',
        reason: anomaly.reason 
      });
    }

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
          ipAddress: clientIP 
        }).save();
        markedCount++;
      }
    }
    
    user.lastKnownIP = clientIP;
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();

    if (markedCount === 0) {
      return res.status(400).json({ error: 'Full Day Attendance already marked!' });
    }
    res.status(201).json({ message: `Full Day Marked (${markedCount} Lectures)!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Admin Manual Attendance -----
app.post('/api/admin/manual-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, status } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }

    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) {
      return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });
    }

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
          ipAddress: 'admin-manual'
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

// 🔥 FIX: GET All Registered Students (Even if no attendance)
app.get('/api/admin/all-students/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    
    // Only Admin can access
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo)) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    
    // Get all users with role 'student'
    const students = await User.find({ role: 'student' })
      .select('name rollNo role anomalyFlag boundDeviceId createdAt')
      .sort({ rollNo: 1 });
    
    res.json(students);
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

// Admin: Get all flagged students (Anomaly detected)
app.get('/api/admin/flagged-students/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    const flaggedStudents = await User.find({ anomalyFlag: true }).select('name rollNo anomalyFlag lastKnownIP lastAttendanceTime');
    res.json(flaggedStudents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Global Error Handler (uncaught exceptions) ----------
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
