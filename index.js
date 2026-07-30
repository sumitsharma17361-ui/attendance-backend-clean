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

// TIME TABLE DATA (B.Tech 5th Sem CSE)
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

// SCHEMAS
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
  location: { latitude: Number, longitude: Number }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

app.get('/', (req, res) => res.send('BM Group Portal API Active!'));

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, rollNo, password } = req.body;
    if (!name || !rollNo || !password) return res.status(400).json({ error: 'All fields required!' });
    const cleanRoll = rollNo.trim().toUpperCase();
    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'Already registered!' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : 'student';
    user = new User({ name, rollNo: cleanRoll, password: hashedPassword, role });
    await user.save();
    res.status(201).json({ message: 'Registration successful!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { rollNo, password } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    const role = ADMIN_ROLL_NUMBERS.includes(cleanRoll) ? 'admin' : user.role;
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Location Distance Helper
function checkLocation(lat, lng) {
  const COLLEGE_LAT = 28.4475; 
  const COLLEGE_LNG = 76.7645;
  const R = 6371; 
  const dLat = (lat - COLLEGE_LAT) * (Math.PI / 180);
  const dLon = (lng - COLLEGE_LNG) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(COLLEGE_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const distance = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  return { isInside: distance <= 1.0, distance: (distance * 1000).toFixed(0) };
}

// Attendance Routes
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date();
    if (today.getDay() === 0 || today.getDay() === 6) return res.status(400).json({ error: 'College is OFF today (Weekend)!' });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Campus! (${locCheck.distance}m away)` });
    const todayDate = today.toISOString().split('T')[0];
    const cleanRoll = rollNo.trim().toUpperCase();
    const exists = await Attendance.findOne({ rollNo: cleanRoll, subject, date: todayDate });
    if (exists) return res.status(400).json({ error: `Already marked for ${subject} today!` });
    await new Attendance({ rollNo: cleanRoll, studentName: name, subject, date: todayDate, status: 'Present', location: { latitude, longitude } }).save();
    res.status(201).json({ message: `Attendance Marked for ${subject}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude } = req.body;
    const today = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];
    if (dayName === 'Sunday' || dayName === 'Saturday') return res.status(400).json({ error: 'College is OFF today!' });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Campus! (${locCheck.distance}m away)` });
    const todayDate = today.toISOString().split('T')[0];
    const cleanRoll = rollNo.trim().toUpperCase();
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
    res.status(201).json({ message: `Full Day Attendance Marked (${markedCount} Lectures)!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const history = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ createdAt: -1 });
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    const allRecords = await Attendance.find().sort({ createdAt: -1 });
    res.json(allRecords);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/attendance/update/:id', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.body.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    const updated = await Attendance.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    res.json({ message: 'Status updated!', updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
