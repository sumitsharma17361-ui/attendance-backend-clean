const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";

const ADMIN_ROLL_NUMBERS = ['24CSE48'];

const TIME_TABLE = {
  Monday: ['BDA', 'ECO', 'DAA', 'FLA', 'HRM', 'CN', 'WT'],
  Tuesday: ['WT', 'ECO', 'Internet', 'FLA', 'HRM', 'BDA'],
  Wednesday: ['BDA', 'ECO', 'FLA', 'WT', 'CN LAB'],
  Thursday: ['BDA', 'CN', 'DAA', 'DAA LAB', 'HRM'],
  Friday: ['DAA', 'CN', 'FLA', 'BDA', 'WT LAB']
};

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('SUCCESS: MongoDB Connected!'))
    .catch(err => console.log('DB ERROR:', err.message));
}

// ==========================================
// SCHEMAS
// ==========================================

// UPDATED USER SCHEMA (Added 'faculty' and 'admin' enum for roles)
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['student', 'faculty', 'admin'], default: 'student' },
  faceDescriptor: { type: [Number], default: [] } // 68-Point Vector Array
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true }, 
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number }
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

// ==========================================
// RBAC MIDDLEWARE (Role-Based Access Control)
// ==========================================
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

app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));

// ==========================================
// AUTH & REGISTRATION
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, rollNo, password } = req.body;
    if (!name || !rollNo || !password) return res.status(400).json({ error: 'All fields required!' });
    
    const cleanRoll = rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    if (!/^\d{2}(CSE|AIDS)\d{2}$/.test(cleanRoll)) return res.status(400).json({ error: 'Invalid Roll format! Only CSE and AIDS branches are allowed, ending with exactly 2 digits (e.g., 24CSE48, 24AIDS12).' });

    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'Roll number already registered!' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : 'student';
    await new User({ name, rollNo: cleanRoll, password: hashedPassword, role }).save();
    res.status(201).json({ message: 'Registration successful!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { rollNo, password } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : user.role;
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// GLOBAL MONGODB FACE MESH ENROLL & SYNC APIs
// ==========================================
app.post('/api/face/enroll', async (req, res) => {
  try {
    const { rollNo, faceDescriptor } = req.body;
    if (!rollNo || !faceDescriptor || faceDescriptor.length === 0) {
      return res.status(400).json({ error: 'Valid Roll No and Face Neural Mesh required!' });
    }
    const cleanRoll = rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const updatedUser = await User.findOneAndUpdate(
      { rollNo: cleanRoll },
      { faceDescriptor },
      { new: true }
    );
    if (!updatedUser) return res.status(404).json({ error: 'Student Profile Not Found!' });
    res.json({ message: 'Face ID Enrolled & Synced Globally to MongoDB!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/face/get/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user || !user.faceDescriptor || user.faceDescriptor.length === 0) {
      return res.status(404).json({ enrolled: false, message: 'Face ID Not Enrolled' });
    }
    res.json({ enrolled: true, faceDescriptor: user.faceDescriptor });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// ADMIN & FACULTY ROUTES
// ==========================================
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo, newPassword } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanRoll = targetRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hashedPassword = await bcrypt.hash(newPassword || '123456', 10);
    const updated = await User.findOneAndUpdate({ rollNo: cleanRoll }, { password: hashedPassword });
    if (!updated) return res.status(404).json({ error: 'Student Roll No not found!' });
    res.json({ message: `Password reset successfully for ${cleanRoll}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/update-rollno', async (req, res) => {
  try {
    const { requesterRollNo, oldRoll, newRoll } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanOld = oldRoll.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanNew = newRoll.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    await User.findOneAndUpdate({ rollNo: cleanOld }, { rollNo: cleanNew });
    await Attendance.updateMany({ rollNo: cleanOld }, { rollNo: cleanNew });

    res.json({ message: `Roll Number updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/delete-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    const cleanTarget = targetRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    await User.findOneAndDelete({ rollNo: cleanTarget });
    await Attendance.deleteMany({ rollNo: cleanTarget });

    res.json({ message: `Account and attendance records deleted for ${cleanTarget}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEW: Faculty Route for manual overrides using RBAC
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

// ==========================================
// BROADCAST NOTICES API
// ==========================================
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 }).limit(3);
    res.json(notices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
      return res.status(403).json({ error: 'Access Denied!' });
    }

    if (!message || message.trim() === "") {
      await Notice.deleteMany({});
      return res.json({ message: 'All Active Notices Cleared Permanently!' });
    }

    await Notice.deleteMany({});
    await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Broadcast Notice Published!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// ATTENDANCE MARKING & GEOFENCING
// ==========================================
function checkLocation(lat, lng) {
  const COLLEGE_LAT = 28.4509370, COLLEGE_LNG = 76.7688120, R = 6371000;
  
  if (!lat || !lng || lat === 0 || lng === 0) {
    return { isInside: false, distance: "GPS Disconnected" };
  }

  const dLat = (lat - COLLEGE_LAT) * (Math.PI / 180);
  const dLon = (lng - COLLEGE_LNG) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(COLLEGE_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const distance = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

  return { isInside: distance <= 500, distance: distance.toFixed(0) };
}

app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date(), todayDate = today.toISOString().split('T')[0];

    if (today.getDay() === 0 || today.getDay() === 6) return res.status(400).json({ error: 'Weekend! College was OFF.' });

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });

    const cleanRoll = rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const exists = await Attendance.findOne({ rollNo: cleanRoll, subject, date: todayDate });
    if (exists) return res.status(400).json({ error: `Already marked for ${subject} today!` });

    await new Attendance({ rollNo: cleanRoll, studentName: name, subject, date: todayDate, status: 'Present', location: { latitude, longitude } }).save();
    res.status(201).json({ message: `Attendance Marked for ${subject}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;
    const today = new Date(), todayDate = today.toISOString().split('T')[0];
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') return res.status(400).json({ error: 'Weekend! College was OFF.' });

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Classroom Boundary! (${locCheck.distance}m away)` });

    const cleanRoll = rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const todaySubjects = TIME_TABLE[dayName] || ['General Class'];
    let markedCount = 0;

    for (let sub of todaySubjects) {
      const exists = await Attendance.findOne({ rollNo: cleanRoll, subject: sub, date: todayDate });
      if (!exists) {
        await new Attendance({ rollNo: cleanRoll, studentName: name, subject: sub, date: todayDate, status: 'Present', location: { latitude, longitude } }).save();
        markedCount++;
      }
    }
    if (markedCount === 0) return res.status(400).json({ error: 'Full Day Attendance already marked!' });
    res.status(201).json({ message: `Full Day Marked (${markedCount} Lectures)!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/manual-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, status } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) return res.status(403).json({ error: 'Access Denied!' });

    const targetRoll = studentRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });

    const parts = date.split('-');
    const targetDateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[targetDateObj.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') return res.status(400).json({ error: 'Target date is a Weekend!' });

    const targetSubjects = TIME_TABLE[dayName] || ['General Class'];
    let markedCount = 0;

    for (let sub of targetSubjects) {
      const exists = await Attendance.findOne({ rollNo: targetRoll, subject: sub, date });
      if (!exists) {
        await new Attendance({ rollNo: targetRoll, studentName: user.name, subject: sub, date, status: status || 'Present', location: { latitude: 28.4509370, longitude: 76.7688120 } }).save();
        markedCount++;
      }
    }
    res.status(201).json({ message: `Marked ${markedCount} lectures for ${user.name} on ${date}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// HOLIDAYS & HISTORY & ANALYTICS
// ==========================================
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) return res.status(403).json({ error: 'Access Denied!' });
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'College Holiday' }, { upsert: true, new: true });
    res.json({ message: `Holiday declared for ${date}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/holidays', async (req, res) => {
  try {
    const holidays = await Holiday.find();
    res.json(holidays);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const history = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') }).sort({ date: -1 });
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) return res.status(403).json({ error: 'Access Denied!' });
    const allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(allRecords);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))) return res.status(403).json({ error: 'Access Denied!' });
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEW: Analytics Route for Chart.js Dashboard
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
      
