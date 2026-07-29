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

// ---------------- DATABASE CONNECTION ----------------
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('SUCCESS: MongoDB Connected Successfully!'))
    .catch(err => console.log('DB CONNECTION ERROR:', err.message));
} else {
  console.log('MONGO_URI missing in Environment Variables!');
}

// ---------------- DATABASE SCHEMAS ----------------

// 1. User Schema (Students / Faculty)
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rollNo: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'student' }
}, { timestamps: true });

// 2. Attendance Schema
const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, default: 'General Attendance' },
  date: { type: String, required: true }, // Format: YYYY-MM-DD
  status: { type: String, enum: ['Present', 'Absent'], default: 'Present' },
  location: {
    latitude: Number,
    longitude: Number
  }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------------- API ENDPOINTS ----------------

// Base Test Route
app.get('/', (req, res) => {
  res.send('BM Group of Institutions - Attendance API is Live!');
});

// 1. Student Registration API
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, rollNo, password } = req.body;

    if (!name || !rollNo || !password) {
      return res.status(400).json({ error: 'All fields are required!' });
    }

    let user = await User.findOne({ rollNo });
    if (user) {
      return res.status(400).json({ error: 'Roll number is already registered!' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ name, rollNo, password: hashedPassword });
    await user.save();

    res.status(201).json({ message: 'Student registered successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Student / Admin Login API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { rollNo, password } = req.body;

    const user = await User.findOne({ rollNo });
    if (!user) {
      return res.status(400).json({ error: 'User not found with this Roll Number!' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid password!' });
    }

    const token = jwt.sign(
      { id: user._id, rollNo: user.rollNo, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: { name: user.name, rollNo: user.rollNo, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Mark Attendance API (Geo-fencing Included for BM Group of Institutions)
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;

    if (!rollNo || !latitude || !longitude) {
      return res.status(400).json({ error: 'Roll number and Location are required!' });
    }

    // --- BM GROUP OF INSTITUTIONS, FARRUKHNAGAR COORDINATES ---
    const COLLEGE_LAT = 28.4485; 
    const COLLEGE_LNG = 76.8143;
    const MAX_ALLOWED_DISTANCE_KM = 1.5; // 1.5 KM radius around campus

    function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
      const R = 6371; // Earth Radius in KM
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
        error: `Attendance Failed: Outside BM Group Campus! (${(distance * 1000).toFixed(0)} meters away)` 
      });
    }

    const todayDate = new Date().toISOString().split('T')[0];

    // Check if already marked today
    const existingRecord = await Attendance.findOne({
      rollNo,
      subject: subject || 'General Attendance',
      date: todayDate
    });

    if (existingRecord) {
      return res.status(400).json({ error: 'Attendance already marked for today!' });
    }

    const newAttendance = new Attendance({
      rollNo,
      studentName: name || 'Student',
      subject: subject || 'General Attendance',
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude }
    });

    await newAttendance.save();
    res.status(201).json({ message: 'Attendance Marked Successfully!', attendance: newAttendance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Get Attendance History API
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const { rollNo } = req.params;
    const history = await Attendance.find({ rollNo }).sort({ createdAt: -1 });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
