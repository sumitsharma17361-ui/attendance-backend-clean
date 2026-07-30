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

app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));

// AUTH & REGISTRATION
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, rollNo, password } = req.body;
    if (!name || !rollNo || !password) return res.status(400).json({ error: 'All fields required!' });
    const cleanRoll = rollNo.trim().toUpperCase();
    if (!/^24CSE\d+$/.test(cleanRoll)) return res.status(400).json({ error: 'Invalid Roll format! Use 24CSE00 pattern.' });

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

// FEATURE 12: ADMIN RESET STUDENT PASSWORD
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// FEATURE 9: BROADCAST NOTICES API
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 }).limit(3);
    res.json(notices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) {
      return res.status(403).json({ error: 'Access Denied!' });
    }
    await new Notice({ title, message }).save();
    res.status(201).json({ message: 'Broadcast Notice Published!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// LOCATION DISTANCE CHECK
function checkLocation(lat, lng) {
  const COLLEGE_LAT = 28.4475, COLLEGE_LNG = 76.7645, R = 6371; 
  const dLat = (lat - COLLEGE_LAT) * (Math.PI / 180);
  const dLon = (lng - COLLEGE_LNG) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(COLLEGE_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const distance = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  return { isInside: distance <= 1.0, distance: (distance * 1000).toFixed(0) };
}

// ATTENDANCE MARKING
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const today = new Date(), todayDate = today.toISOString().split('T')[0];

    if (today.getDay() === 0 || today.getDay() === 6) return res.status(400).json({ error: 'Weekend! College was OFF.' });

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Campus! (${locCheck.distance}m away)` });

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
    const today = new Date(), todayDate = today.toISOString().split('T')[0];
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[today.getDay()];

    if (dayName === 'Sunday' || dayName === 'Saturday') return res.status(400).json({ error: 'Weekend! College was OFF.' });

    const isHoliday = await Holiday.findOne({ date: todayDate });
    if (isHoliday) return res.status(400).json({ error: `Holiday: ${isHoliday.reason}` });

    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside Campus! (${locCheck.distance}m away)` });

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
    res.status(201).json({ message: `Full Day Marked (${markedCount} Lectures)!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ADMIN BACKDATE
app.post('/api/admin/manual-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, status } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied!' });

    const targetRoll = studentRollNo.trim().toUpperCase();
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
        await new Attendance({ rollNo: targetRoll, studentName: user.name, subject: sub, date, status: status || 'Present', location: { latitude: 28.4475, longitude: 76.7645 } }).save();
        markedCount++;
      }
    }
    res.status(201).json({ message: `Marked ${markedCount} lectures for ${user.name} on ${date}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// HOLIDAYS & HISTORY
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    if (!ADMIN_ROLL_NUMBERS.includes(requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied!' });
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
    const history = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    res.json(history);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied!' });
    const allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(allRecords);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    if (!ADMIN_ROLL_NUMBERS.includes(req.params.requesterRollNo.trim().toUpperCase())) return res.status(403).json({ error: 'Access Denied!' });
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
