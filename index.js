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

// ADMIN ROLL NUMBERS
const ADMIN_ROLL_NUMBERS = ['24CSE48'];

// ---------------- TIME TABLE DATA (B.Tech 5th Sem CSE) ----------------
const TIME_TABLE = {
  Monday: [
    { period: 1, time: '09:20 - 10:05', subject: 'BDA', faculty: 'Ms. Rashmi' },
    { period: 2, time: '10:05 - 10:50', subject: 'ECO', faculty: 'Ms. Sakshi Yadav' },
    { period: 3, time: '10:50 - 11:35', subject: 'DAA', faculty: 'Ms. Rashmi' },
    { period: 4, time: '11:35 - 12:20', subject: 'FLA', faculty: 'Ms. Nisha' },
    { period: 5, time: '12:20 - 01:05', subject: 'LUNCH BREAK', faculty: '-' },
    { period: 6, time: '01:05 - 01:50', subject: 'HRM', faculty: 'Msr. Lokesh' },
    { period: 7, time: '01:50 - 02:35', subject: 'CN', faculty: 'Mr. Chhatarpal' },
    { period: 8, time: '02:35 - 03:20', subject: 'WT', faculty: 'Mr. Avish Yadav' }
  ],
  Tuesday: [
    { period: 1, time: '09:20 - 10:05', subject: 'WT', faculty: 'Mr. Avish Yadav' },
    { period: 2, time: '10:05 - 10:50', subject: 'ECO', faculty: 'Ms. Sakshi Yadav' },
    { period: 3, time: '10:50 - 11:35', subject: 'Internet', faculty: 'Ms. Geeta' },
    { period: 4, time: '11:35 - 12:20', subject: 'FLA', faculty: 'Ms. Nisha' },
    { period: 5, time: '12:20 - 01:05', subject: 'LUNCH BREAK', faculty: '-' },
    { period: 6, time: '01:05 - 01:50', subject: 'HRM', faculty: 'Msr. Lokesh' },
    { period: 7, time: '01:50 - 02:35', subject: 'BDA', faculty: 'Ms. Rashmi' },
    { period: 8, time: '02:35 - 03:20', subject: 'SPORTS', faculty: '-' }
  ],
  Wednesday: [
    { period: 1, time: '09:20 - 10:05', subject: 'BDA', faculty: 'Ms. Rashmi' },
    { period: 2, time: '10:05 - 10:50', subject: 'ECO', faculty: 'Ms. Sakshi Yadav' },
    { period: 3, time: '10:50 - 11:35', subject: 'FLA', faculty: 'Ms. Nisha' },
    { period: 4, time: '11:35 - 12:20', subject: 'SPORTS', faculty: '-' },
    { period: 5, time: '12:20 - 01:05', subject: 'LUNCH BREAK', faculty: '-' },
    { period: 6, time: '01:05 - 01:50', subject: 'WT', faculty: 'Mr. Avish Yadav' },
    { period: 7, time: '01:50 - 03:20', subject: 'CN LAB', faculty: 'Mr. Chhatarpal' }
  ],
  Thursday: [
    { period: 1, time: '09:20 - 10:05', subject: 'BDA', faculty: 'Ms. Rashmi' },
    { period: 2, time: '10:05 - 10:50', subject: 'CN', faculty: 'Mr. Chhatarpal' },
    { period: 3, time: '10:50 - 11:35', subject: 'SPORTS', faculty: '-' },
    { period: 4, time: '11:35 - 12:20', subject: 'DAA', faculty: 'Ms. Rashmi' },
    { period: 5, time: '12:20 - 01:05', subject: 'LUNCH BREAK', faculty: '-' },
    { period: 6, time: '01:05 - 02:35', subject: 'DAA LAB', faculty: 'Ms. Rashmi' },
    { period: 8, time: '02:35 - 03:20', subject: 'HRM', faculty: 'Msr. Lokesh' }
  ],
  Friday: [
    { period: 1, time: '09:20 - 10:05', subject: 'DAA', faculty: 'Ms. Rashmi' },
    { period: 2, time: '10:05 - 10:50', subject: 'CN', faculty: 'Mr. Chhatarpal' },
    { period: 3, time: '10:50 - 11:35', subject: 'FLA', faculty: 'Ms. Nisha' },
    { period: 4, time: '11:35 - 12:20', subject: 'BDA', faculty: 'Ms. Rashmi' },
    { period: 5, time: '12:20 - 01:05', subject: 'LUNCH BREAK', faculty: '-' },
    { period: 6, time: '01:05 - 02:35', subject: 'WT LAB', faculty: 'Mr. Avish Yadav' },
    { period: 8, time: '02:35 - 03:20', subject: 'SPORTS', faculty: '-' }
  ]
};

// ---------------- DATABASE CONNECTION ----------------
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('SUCCESS: MongoDB Connected Successfully!'))
    .catch(err => console.log('DB CONNECTION ERROR:', err.message));
} else {
  console.log('MONGO_URI missing in Environment Variables!');
}

// ---------------- DATABASE SCHEMAS ----------------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'student' }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true }, 
  status: { type: String, enum: ['Present', 'Absent'], default: 'Present' },
  location: {
    latitude: Number,
    longitude: Number
  }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------------- API ENDPOINTS ----------------

app.get('/', (req, res) => {
  res.send('BM Group of Institutions - B.Tech 5th Sem CSE Portal Active!');
});

// Time-Table API
app.get('/api/timetable', (req, res) => {
  res.json(TIME_TABLE);
});

// Student Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, rollNo, password } = req.body;
    if (!name || !rollNo || !password) return res.status(400).json({ error: 'All fields required!' });

    const cleanRollNo = rollNo.trim().toUpperCase();
    let user = await User.findOne({ rollNo: cleanRollNo });
    if (user) return res.status(400).json({ error: 'Roll number already registered!' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRollNo) ? 'admin' : 'student';

    user = new User({ name, rollNo: cleanRollNo, password: hashedPassword, role });
    await user.save();
    res.status(201).json({ message: 'Registration successful!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { rollNo, password } = req.body;
    const cleanRollNo = rollNo.trim().toUpperCase();

    const user = await User.findOne({ rollNo: cleanRollNo });
    if (!user) return res.status(400).json({ error: 'User not found!' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });

    const role = ADMIN_ROLL_NUMBERS.includes(cleanRollNo) ? 'admin' : user.role;

    const token = jwt.sign(
      { id: user._id, rollNo: user.rollNo, name: user.name, role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: { name: user.name, rollNo: user.rollNo, role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark Attendance (BM Group Geo-Fencing + Subject Wise)
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    if (!rollNo || !latitude || !longitude || !subject) {
      return res.status(400).json({ error: 'Roll Number, Subject and Location required!' });
    }

    const COLLEGE_LAT = 28.4485; 
    const COLLEGE_LNG = 76.8143;
    const MAX_ALLOWED_DISTANCE_KM = 1.5; 

    function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
      const R = 6371; 
      const dLat = (lat2 - lat1) * (Math.PI / 180);
      const dLon = (lon2 - lon1) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    const distance = getDistanceFromLatLonInKm(latitude, longitude, COLLEGE_LAT, COLLEGE_LNG);

    if (distance > MAX_ALLOWED_DISTANCE_KM) {
      return res.status(400).json({ 
        error: `Outside BM Group Campus! (${(distance * 1000).toFixed(0)}m away)` 
      });
    }

    const todayDate = new Date().toISOString().split('T')[0];
    const cleanRollNo = rollNo.trim().toUpperCase();

    // Check if already marked for this subject today
    const existingRecord = await Attendance.findOne({
      rollNo: cleanRollNo,
      subject: subject,
      date: todayDate
    });

    if (existingRecord) {
      return res.status(400).json({ error: `Attendance already marked for ${subject} today!` });
    }

    const newAttendance = new Attendance({
      rollNo: cleanRollNo,
      studentName: name || 'Student',
      subject: subject,
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude }
    });

    await newAttendance.save();
    res.status(201).json({ message: `Attendance Marked for ${subject}!`, attendance: newAttendance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Individual History
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const cleanRollNo = req.params.rollNo.trim().toUpperCase();
    const history = await Attendance.find({ rollNo: cleanRollNo }).sort({ createdAt: -1 });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN ALL ATTENDANCE
app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    const requester = req.params.requesterRollNo.trim().toUpperCase();

    if (!ADMIN_ROLL_NUMBERS.includes(requester)) {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }

    const allRecords = await Attendance.find().sort({ createdAt: -1 });
    res.json(allRecords);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
