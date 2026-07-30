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
  Monday: ['BDA', 'ECO', 'DAA', 'FLA', 'HRM', 'CN', 'WT'],
  Tuesday: ['WT', 'ECO', 'Internet', 'FLA', 'HRM', 'BDA'],
  Wednesday: ['BDA', 'ECO', 'FLA', 'WT', 'CN LAB'],
  Thursday: ['BDA', 'CN', 'DAA', 'DAA LAB', 'HRM'],
  Friday: ['DAA', 'CN', 'FLA', 'BDA', 'WT LAB']
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
  res.send('B. M. Group Of Institutions - Professional Enterprise Portal Active!');
});

// Time-Table API
app.get('/api/timetable', (req, res) => {
  res.json(TIME_TABLE);
});

// Register API
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

// GPS Distance Helper
function checkLocation(lat, lng) {
  const COLLEGE_LAT = 28.4475; 
  const COLLEGE_LNG = 76.7645;
  const MAX_ALLOWED_DISTANCE_KM = 1.0;

  const R = 6371; 
  const dLat = (lat - COLLEGE_LAT) * (Math.PI / 180);
  const dLon = (lng - COLLEGE_LNG) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(COLLEGE_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return { isInside: distance <= MAX_ALLOWED_DISTANCE_KM, distance: (distance * 1000).toFixed(0) };
}

// Single Subject Mark
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;

    const today = new Date();
    const dayOfWeek = today.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return res.status(400).json({ error: 'College is OFF today (Weekend)!' });
    }

    if (!rollNo || !latitude || !longitude || !subject) {
      return res.status(400).json({ error: 'Roll Number, Subject & Location required!' });
    }

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      return res.status(400).json({ error: `Outside Campus Boundary! (${locCheck.distance}m away)` });
    }

    const todayDate = today.toISOString().split('T')[0];
    const cleanRollNo = rollNo.trim().toUpperCase();

    const existingRecord = await Attendance.findOne({ rollNo: cleanRollNo, subject, date: todayDate });
    if (existingRecord) {
      return res.status(400).json({ error: `Already marked for ${subject} today!` });
    }

    await new Attendance({
      rollNo: cleanRollNo,
      studentName: name || 'Student',
      subject,
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude }
    }).save();

    res.status(201).json({ message: `Attendance Recorded for ${subject}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full Day Mark
app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;

    const today = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDayName = days[today.getDay()];

    if (currentDayName === 'Sunday' || currentDayName === 'Saturday') {
      return res.status(400).json({ error: 'College is OFF today (Weekend)!' });
    }

    if (!rollNo || !latitude || !longitude) {
      return res.status(400).json({ error: 'Roll Number & Location required!' });
    }

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      return res.status(400).json({ error: `Outside Campus Boundary! (${locCheck.distance}m away)` });
    }

    const todayDate = today.toISOString().split('T')[0];
    const cleanRollNo = rollNo.trim().toUpperCase();

    const todaySubjects = TIME_TABLE[currentDayName] || ['General Attendance'];
    let markedCount = 0;

    for (let sub of todaySubjects) {
      const exists = await Attendance.findOne({ rollNo: cleanRollNo, subject: sub, date: todayDate });
      if (!exists) {
        await new Attendance({
          rollNo: cleanRollNo,
          studentName: name || 'Student',
          subject: sub,
          date: todayDate,
          status: 'Present',
          location: { latitude, longitude }
        }).save();
        markedCount++;
      }
    }

    if (markedCount === 0) {
      return res.status(400).json({ error: 'Full Day Attendance already marked for today!' });
    }

    res.status(201).json({ message: `Full Day Attendance Marked (${markedCount} Lectures)!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History
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
      return res.status(403).json({ error: 'Access Denied: Admin Privileges Required!' });
    }

    const allRecords = await Attendance.find().sort({ createdAt: -1 });
    res.json(allRecords);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
