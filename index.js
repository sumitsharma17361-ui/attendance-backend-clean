// ============================================================
// COMPLETE BACKEND - attendancenew.js (with chat fix)
// ============================================================
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
const GROK_API_KEY = process.env.GROK_API_KEY;
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 50;
const SEMESTER_START = new Date(2026, 6, 15);
const SEMESTER_END = new Date(2026, 11, 31);

if (!MONGO_URI) {
  console.error('❌ FATAL: MONGO_URI environment variable is not set!');
  process.exit(1);
}

// ---------- Rate Limiting ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts, try again after 15 minutes.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Too many requests, please slow down.' } });

app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// ---------- Zod Validation Schemas ----------
const registerSchema = z.object({
  name: z.string().min(2, "Name too short").max(50),
  rollNo: z.string().min(3, "ID too short"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  deviceId: z.string().optional(),
  role: z.enum(['student', 'faculty', 'admin']).default('student'),
  subject: z.string().optional().nullable()
});

const loginSchema = z.object({
  rollNo: z.string().min(1, "ID required"),
  password: z.string().min(1, "Password required"),
  deviceId: z.string().optional()
});

// ---------- Timetables with Faculty Names ----------
const SUBJECT_FACULTY_MAP = {
  'BDA - Big Data Analytics': 'Ms. Geeta',
  'ECO - Economics for Engineers': 'Ms. Sakshi Yadav',
  'DAA - Design & Analysis of Algorithm': 'Ms. Rashmi',
  'FLA - Formal Language & Automata': 'Ms. Nisha Yadav',
  'HRM - Human Resource Mgmt': 'Mr. Lokesh',
  'CN - Computer Network': 'Mr. Chhetrapal',
  'WT - Web Technology': 'Mr. Avish Yadav',
  'Internet Lab (Ms. Geeta)': 'Ms. Geeta',
  'CN LAB - Computer Network Lab': 'Mr. Chhetrapal',
  'DAA LAB - Algorithm Lab': 'Ms. Rashmi',
  'WT LAB - Web Technology Lab': 'Mr. Avish Yadav',
  'LIB - Library': 'Library Staff',
  'PA - Predictive Analysis': 'Ms. Pooja',
  'ML - Machine Learning': 'Mr. Harsh',
  'PA LAB - Predictive Analysis Lab': 'Ms. Pooja',
  'ML LAB - Machine Learning Lab': 'Mr. Harsh',
  'BDA LAB - Big Data Analytics Lab': 'Ms. Geeta',
  'Sports': 'Sports Dept',
  'Sports / Project': 'Sports Dept'
};

const SUBJECT_CODE_MAP = {
  'BDA - Big Data Analytics': 'BDA',
  'ECO - Economics for Engineers': 'ECO',
  'DAA - Design & Analysis of Algorithm': 'DAA',
  'FLA - Formal Language & Automata': 'FLA',
  'HRM - Human Resource Mgmt': 'HRM',
  'CN - Computer Network': 'CN',
  'WT - Web Technology': 'WT',
  'Internet Lab (Ms. Geeta)': 'INT',
  'CN LAB - Computer Network Lab': 'CNL',
  'DAA LAB - Algorithm Lab': 'DAAL',
  'WT LAB - Web Technology Lab': 'WTL',
  'LIB - Library': 'LIB',
  'PA - Predictive Analysis': 'PA',
  'ML - Machine Learning': 'ML',
  'PA LAB - Predictive Analysis Lab': 'PAL',
  'ML LAB - Machine Learning Lab': 'MLL',
  'BDA LAB - Big Data Analytics Lab': 'BDAL',
  'Sports': 'SPT',
  'Sports / Project': 'SPT'
};

function getTimetableFaculty() {
  const facultySet = new Set();
  const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  allDays.forEach(day => {
    CSE_TIME_TABLE[day].forEach(entry => facultySet.add(entry.faculty));
    AIDS_TIME_TABLE[day].forEach(entry => facultySet.add(entry.faculty));
  });
  return [...facultySet].sort();
}

const SUBJECT_SHORT_TO_FULL = {
  'BDA': 'BDA - Big Data Analytics',
  'ECO': 'ECO - Economics for Engineers',
  'DAA': 'DAA - Design & Analysis of Algorithm',
  'FLA': 'FLA - Formal Language & Automata',
  'HRM': 'HRM - Human Resource Mgmt',
  'CN': 'CN - Computer Network',
  'WT': 'WT - Web Technology',
  'CN LAB': 'CN LAB - Computer Network Lab',
  'DAA LAB': 'DAA LAB - Algorithm Lab',
  'WT LAB': 'WT LAB - Web Technology Lab',
  'LIB': 'LIB - Library',
  'PA': 'PA - Predictive Analysis',
  'ML': 'ML - Machine Learning',
  'PA LAB': 'PA LAB - Predictive Analysis Lab',
  'ML LAB': 'ML LAB - Machine Learning Lab',
  'BDA LAB': 'BDA LAB - Big Data Analytics Lab'
};

function getFullSubjectName(shortOrFull) {
  return SUBJECT_SHORT_TO_FULL[shortOrFull] || shortOrFull;
}

const CSE_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'LIB - Library', faculty: 'Library Staff' }
  ],
  Tuesday: [
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'Internet Lab (Ms. Geeta)', faculty: 'Ms. Geeta' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' }
  ],
  Wednesday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'CN LAB - Computer Network Lab', faculty: 'Mr. Chhetrapal' }
  ],
  Thursday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'DAA LAB - Algorithm Lab', faculty: 'Ms. Rashmi' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }
  ],
  Friday: [
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT LAB - Web Technology Lab', faculty: 'Mr. Avish Yadav' }
  ]
};

const AIDS_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'LIB - Library', faculty: 'Library Staff' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Tuesday: [
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' }
  ],
  Wednesday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'Sports / Project', faculty: 'Sports Dept' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'PA LAB - Predictive Analysis Lab', faculty: 'Ms. Pooja' }
  ],
  Thursday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' },
    { subject: 'PA - Predictive Analysis', faculty: 'Ms. Pooja' },
    { subject: 'ML LAB - Machine Learning Lab', faculty: 'Mr. Harsh' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' }
  ],
  Friday: [
    { subject: 'ML - Machine Learning', faculty: 'Mr. Harsh' },
    { subject: 'LIB - Library', faculty: 'Library Staff' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'BDA LAB - Big Data Analytics Lab', faculty: 'Ms. Geeta' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ]
};

function getTimetableForBranch(branch) {
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE;
  return CSE_TIME_TABLE;
}

// ---------- Helper Functions ----------
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
    if (!isWeekend && !holidaySet.has(dateStr)) workingDays++;
    current.setDate(current.getDate() + 1);
  }
  return workingDays;
}

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

async function generateTeacherId(subject) {
  const code = SUBJECT_CODE_MAP[subject] || 'TCH';
  const existing = await User.find({
    rollNo: { $regex: `^${code}\\d{2}$` },
    role: 'faculty'
  });
  let maxNum = 0;
  existing.forEach(user => {
    const num = parseInt(user.rollNo.replace(code, ''));
    if (num > maxNum) maxNum = num;
  });
  const newNum = String(maxNum + 1).padStart(2, '0');
  return `${code}${newNum}`;
}

// ---------- Schedule for period detection ----------
const CSE_SCHEDULE = {
  1: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "DAA - Design & Analysis of Algorithm", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
    { start: "13:50", end: "14:35", subject: "CN - Computer Network", period: "P7" },
    { start: "14:35", end: "15:20", subject: "LIB - Library", period: "P8" }
  ],
  2: [
    { start: "09:20", end: "10:05", subject: "WT - Web Technology", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "Internet Lab (Ms. Geeta)", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
    { start: "13:50", end: "14:35", subject: "BDA - Big Data Analytics", period: "P7" },
    { start: "14:35", end: "15:20", subject: "Sports / Library", period: "P8" }
  ],
  3: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "FLA - Formal Language & Automata", period: "P3" },
    { start: "11:35", end: "12:20", subject: "Sports / Activity", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "WT - Web Technology", period: "P6" },
    { start: "13:50", end: "15:20", subject: "CN LAB - Computer Network Lab", period: "P7-P8" }
  ],
  4: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "WT - Web Technology", period: "P2" },
    { start: "10:50", end: "11:35", subject: "CN - Computer Network", period: "P3" },
    { start: "11:35", end: "12:20", subject: "DAA - Design & Analysis of Algorithm", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "14:35", subject: "DAA LAB - Algorithm Lab", period: "P6-P7" },
    { start: "14:35", end: "15:20", subject: "HRM - Human Resource Mgmt", period: "P8" }
  ],
  5: [
    { start: "09:20", end: "10:05", subject: "DAA - Design & Analysis of Algorithm", period: "P1" },
    { start: "10:05", end: "10:50", subject: "CN - Computer Network", period: "P2" },
    { start: "10:50", end: "11:35", subject: "FLA - Formal Language & Automata", period: "P3" },
    { start: "11:35", end: "12:20", subject: "BDA - Big Data Analytics", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "14:35", subject: "WT LAB - Web Technology Lab", period: "P6-P7" },
    { start: "14:35", end: "15:20", subject: "Sports / Library", period: "P8" }
  ]
};

const AIDS_SCHEDULE = {
  1: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "LIB - Library", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "PA - Predictive Analysis", period: "P6" },
    { start: "13:50", end: "14:35", subject: "PA - Predictive Analysis", period: "P7" },
    { start: "14:35", end: "15:20", subject: "Sports", period: "P8" }
  ],
  2: [
    { start: "09:20", end: "10:05", subject: "WT - Web Technology", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "PA - Predictive Analysis", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
    { start: "13:50", end: "14:35", subject: "BDA - Big Data Analytics", period: "P7" },
    { start: "14:35", end: "15:20", subject: "ML - Machine Learning", period: "P8" }
  ],
  3: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "FLA - Formal Language & Automata", period: "P3" },
    { start: "11:35", end: "12:20", subject: "Sports / Project", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "WT - Web Technology", period: "P6" },
    { start: "13:50", end: "15:20", subject: "PA LAB - Predictive Analysis Lab", period: "P7-P8" }
  ],
  4: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "WT - Web Technology", period: "P2" },
    { start: "10:50", end: "11:35", subject: "ML - Machine Learning", period: "P3" },
    { start: "11:35", end: "12:20", subject: "PA - Predictive Analysis", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "14:35", subject: "ML LAB - Machine Learning Lab", period: "P6-P7" },
    { start: "14:35", end: "15:20", subject: "HRM - Human Resource Mgmt", period: "P8" }
  ],
  5: [
    { start: "09:20", end: "10:05", subject: "ML - Machine Learning", period: "P1" },
    { start: "10:05", end: "10:50", subject: "LIB - Library", period: "P2" },
    { start: "10:50", end: "11:35", subject: "FLA - Formal Language & Automata", period: "P3" },
    { start: "11:35", end: "12:20", subject: "BDA - Big Data Analytics", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "14:35", subject: "BDA LAB - Big Data Analytics Lab", period: "P6-P7" },
    { start: "14:35", end: "15:20", subject: "Sports", period: "P8" }
  ]
};

function getScheduleForBranch(branch) {
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_SCHEDULE;
  return CSE_SCHEDULE;
}

function getCurrentPeriod(branch = 'CSE') {
  const now = new Date();
  const day = now.getDay(); // 1=Monday, 5=Friday
  if (day === 0 || day === 6) return null; // weekend
  const schedule = getScheduleForBranch(branch);
  const daySchedule = schedule[day] || [];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  for (let slot of daySchedule) {
    const startMins = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
    const endMins = parseInt(slot.end.split(':')[0]) * 60 + parseInt(slot.end.split(':')[1]);
    if (currentMinutes >= startMins && currentMinutes < endMins) {
      return slot;
    }
  }
  return null;
}

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
  activeSession: { type: String, default: null },
  facultySubject: { type: String, default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  studentName: { type: String, required: true },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent', 'Duty Leave', 'Holiday'], default: 'Present' },
  location: { latitude: Number, longitude: Number },
  ipAddress: { type: String, default: null },
  isVerified: { type: Boolean, default: false },
  branch: { type: String, default: 'CSE' }
}, { timestamps: true });

attendanceSchema.index({ rollNo: 1, subject: 1, date: 1 }, { unique: true });

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
  passcode: { type: String, required: true },
  type: { type: String, enum: ['full_day', 'single_lecture'], required: true },
  key: { type: String, unique: true, sparse: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

const teacherSubjectSchema = new mongoose.Schema({
  teacherRollNo: { type: String, required: true },
  subject: { type: String, required: true },
  assignedBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Chat schema
const chatSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  threadId: { type: String, required: true, unique: true },
  title: { type: String, default: 'New Chat' },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);
const TeacherSubject = mongoose.model('TeacherSubject', teacherSubjectSchema);
const Chat = mongoose.model('Chat', chatSchema);

Attendance.createIndexes().catch(err => console.error('Index creation error:', err));

// ---------- Helper function for student summary (used in chat) ----------
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date));
    const today = new Date();
    const semesterStart = new Date(2026, 6, 15);
    let current = new Date(semesterStart);
    let totalConductedAcademicSubjects = 0;
    const subjectStats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcademicSubjects = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subjects = timetable[dayName] || [];
      const academic = subjects.filter(entry => !entry.subject.includes("LIB") && !entry.subject.includes("Library") && !entry.subject.includes("Sports"));
      dayAcademicSubjects[dayName] = academic.map(entry => entry.subject);
    }
    while (current <= today) {
      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dayOfWeek];
        const academicSubjects = dayAcademicSubjects[dayName] || [];
        totalConductedAcademicSubjects += academicSubjects.length;
        academicSubjects.forEach(sub => {
          if (!subjectStats[sub]) subjectStats[sub] = { total: 0, present: 0 };
          subjectStats[sub].total = (subjectStats[sub].total || 0) + 1;
        });
      }
      current.setDate(current.getDate() + 1);
    }
    const subjectPresentCount = {};
    allRecords.forEach(rec => {
      const sub = getFullSubjectName(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        if (!subjectPresentCount[sub]) subjectPresentCount[sub] = 0;
        subjectPresentCount[sub] = (subjectPresentCount[sub] || 0) + 1;
      }
    });
    Object.keys(subjectPresentCount).forEach(sub => {
      if (subjectStats[sub]) subjectStats[sub].present = subjectPresentCount[sub];
    });
    let totalAcademicLecturesAttended = 0;
    Object.values(subjectPresentCount).forEach(v => totalAcademicLecturesAttended += v);
    const pct = totalConductedAcademicSubjects > 0 ? Math.round((totalAcademicLecturesAttended / totalConductedAcademicSubjects) * 100) : 0;
    const subjectStatsFinal = {};
    for (let [sub, stats] of Object.entries(subjectStats)) {
      subjectStatsFinal[sub] = {
        present: stats.present || 0,
        total: stats.total || 0,
        percentage: stats.total > 0 ? Math.round(((stats.present || 0) / stats.total) * 100) : 0
      };
    }
    return {
      totalAcademicLectures: totalAcademicLecturesAttended,
      totalConductedLectures: totalConductedAcademicSubjects,
      attendancePercentage: pct,
      subjectStats: subjectStatsFinal
    };
  } catch (e) {
    console.error('Error in getStudentSummary:', e);
    return null;
  }
}

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));

// ========== AUTH ==========
app.post('/api/auth/register', async (req, res) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.errors[0].message });
    }
    let { name, rollNo, password, deviceId, role, subject } = parseResult.data;
    let cleanRoll = rollNo.trim().toUpperCase();
    
    if (role === 'student') {
      if (!/^24(CSE|AIDS)\d{2}$/.test(cleanRoll)) {
        return res.status(400).json({ error: 'Invalid Roll Number format! Use 24CSE01 or 24AIDS01 format.' });
      }
    }
    
    if (role === 'faculty' && (!cleanRoll || cleanRoll === 'AUTO' || cleanRoll === '')) {
      if (!subject) return res.status(400).json({ error: 'Subject required for faculty registration!' });
      cleanRoll = await generateTeacherId(subject);
    }
    
    let user = await User.findOne({ rollNo: cleanRoll });
    if (user) return res.status(400).json({ error: 'ID already registered!' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    let branch = 'CSE';
    if (role === 'student' && cleanRoll.includes('AIDS')) branch = 'AIDS';
    const boundDeviceId = (role === 'student') ? (deviceId || null) : null;
    
    const newUser = new User({
      name,
      rollNo: cleanRoll,
      password: hashedPassword,
      role,
      boundDeviceId,
      branch,
      facultySubject: (role === 'faculty') ? subject : null
    });
    await newUser.save();
    
    if (role === 'faculty' && subject) {
      await TeacherSubject.create({
        teacherRollNo: cleanRoll,
        subject: subject,
        assignedBy: cleanRoll
      });
    }
    
    res.status(201).json({
      message: `${role} ${name} Registered!`,
      rollNo: cleanRoll
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    const { rollNo, password, deviceId } = parseResult.data;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(400).json({ error: 'User not found!' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid password!' });
    user.failedAttempts = 0;
    user.blockUntil = null;
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { user.boundDeviceId = deviceId; await user.save(); }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) {
        return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
      }
    }
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token;
    await user.save();
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role, branch: user.branch } });
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

// ========== VERIFY PASSCODE ==========
app.post('/api/auth/verify-passcode', async (req, res) => {
  try {
    const { passcode, type } = req.body;
    if (!passcode || !type) {
      return res.status(400).json({ error: 'Passcode and type are required.' });
    }
    const doc = await Passcode.findOne({
      passcode: passcode.trim(),
      type: type,
      expiresAt: { $gt: new Date() }
    });
    if (doc) {
      res.json({ valid: true, message: 'Passcode is valid.' });
    } else {
      res.status(400).json({ error: 'Invalid or expired passcode.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== PROFILE ==========
app.post('/api/student/profile', async (req, res) => {
  try {
    const { rollNo, email, phone, profilePic, semester, branch } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found!' });
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
    if (!user) return res.status(404).json({ error: 'User not found!' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ADMIN ROUTES ==========
app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo, newPassword } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const hashedPassword = await bcrypt.hash(newPassword || '123456', 10);
    const updated = await User.findOneAndUpdate({ rollNo: cleanRoll }, { password: hashedPassword });
    if (!updated) return res.status(404).json({ error: 'User not found!' });
    res.json({ message: `Password reset for ${cleanRoll}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: `User ${cleanRoll} not found!` });
    user.boundDeviceId = null;
    await user.save();
    res.json({ message: `✅ Device binding reset for ${cleanRoll}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/update-rollno', async (req, res) => {
  try {
    const { requesterRollNo, oldRoll, newRoll } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanOld = oldRoll.trim().toUpperCase();
    const cleanNew = newRoll.trim().toUpperCase();
    await User.findOneAndUpdate({ rollNo: cleanOld }, { rollNo: cleanNew });
    await Attendance.updateMany({ rollNo: cleanOld }, { rollNo: cleanNew });
    res.json({ message: `Roll Number updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/delete-user', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTarget = targetRollNo.trim().toUpperCase();
    await User.findOneAndDelete({ rollNo: cleanTarget });
    await Attendance.deleteMany({ rollNo: cleanTarget });
    await TeacherSubject.deleteMany({ teacherRollNo: cleanTarget });
    res.json({ message: `Account and records deleted for ${cleanTarget}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/login-as-student', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTarget = targetRollNo.trim().toUpperCase();
    const student = await User.findOne({ rollNo: cleanTarget });
    if (!student) return res.status(404).json({ error: 'Student not found!' });
    const token = jwt.sign({ id: student._id, rollNo: student.rollNo, name: student.name, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ message: `Logged in as ${student.name}`, token, user: { name: student.name, rollNo: student.rollNo, role: 'student' }, isImpersonating: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== TEACHER SUBJECT ASSIGNMENT ==========
app.post('/api/admin/assign-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTeacher = teacherRollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanTeacher, role: 'faculty' });
    if (!teacher) return res.status(404).json({ error: 'Faculty not found!' });
    const existing = await TeacherSubject.findOne({ teacherRollNo: cleanTeacher, subject });
    if (existing) return res.status(400).json({ error: 'Subject already assigned to this teacher.' });
    await TeacherSubject.create({ teacherRollNo: cleanTeacher, subject, assignedBy: requesterRollNo });
    res.json({ message: `Subject "${subject}" assigned to ${cleanTeacher}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/remove-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTeacher = teacherRollNo.trim().toUpperCase();
    await TeacherSubject.findOneAndDelete({ teacherRollNo: cleanTeacher, subject });
    res.json({ message: `Subject "${subject}" removed from ${cleanTeacher}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/teacher/subjects/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const assignments = await TeacherSubject.find({ teacherRollNo: cleanRoll });
    res.json(assignments.map(a => a.subject));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== TEACHER GET STUDENTS ==========
app.get('/api/teacher/students/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanRoll, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Teacher not found!' });
    const subjects = await TeacherSubject.find({ teacherRollNo: cleanRoll }).distinct('subject');
    if (subjects.length === 0) return res.json([]);
    const records = await Attendance.find({ subject: { $in: subjects } }).distinct('rollNo');
    const students = await User.find({ rollNo: { $in: records }, role: 'student' }).select('name rollNo');
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== TEACHER MARK ATTENDANCE ==========
app.post('/api/teacher/mark-attendance', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, studentRollNo } = req.body;
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanRoll, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Only faculty can mark attendance.' });
    const assignment = await TeacherSubject.findOne({ teacherRollNo: cleanRoll, subject });
    if (!assignment) return res.status(403).json({ error: `Not authorized for "${subject}".` });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    if (!studentRollNo) return res.status(400).json({ error: 'Student roll number required.' });
    const cleanStudent = studentRollNo.trim().toUpperCase();
    const studentUser = await User.findOne({ rollNo: cleanStudent, role: 'student' });
    if (!studentUser) return res.status(404).json({ error: 'Student not found!' });
    const exists = await Attendance.findOne({ rollNo: cleanStudent, subject, date: todayDate });
    if (exists) return res.status(400).json({ error: `Already marked for ${subject} today.` });
    await new Attendance({
      rollNo: cleanStudent,
      studentName: studentUser.name,
      subject,
      date: todayDate,
      status: 'Present',
      location: { latitude, longitude },
      ipAddress: req.ip,
      isVerified: true,
      branch: studentUser.branch || 'CSE'
    }).save();
    res.status(201).json({ message: `✅ Marked ${studentUser.name} (${subject})` });
  } catch (err) { console.error('Teacher attendance error:', err); res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE (Admin & Teacher) ==========
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'User not found!' });
    
    if (requester.role === 'admin') {
      // allowed both
    } else if (requester.role === 'faculty' && type === 'single_lecture') {
      // allowed
    } else {
      return res.status(403).json({ error: 'Access Denied: Only admin can generate full_day, teacher can generate single_lecture.' });
    }
    
    if (!type || !['full_day', 'single_lecture'].includes(type)) {
      return res.status(400).json({ error: 'Invalid passcode type.' });
    }

    if (type === 'single_lecture') {
      const branch = requester.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) {
        return res.status(400).json({ error: 'No active lecture period right now.' });
      }
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const key = `single_lecture_${dateStr}_${period.start}`;
      
      let passcodeDoc = await Passcode.findOne({ key, type: 'single_lecture' });
      if (passcodeDoc && passcodeDoc.expiresAt > new Date()) {
        return res.json({ message: 'Existing passcode retrieved', passcode: passcodeDoc.passcode, type, expiresAt: passcodeDoc.expiresAt });
      }
      
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const endParts = period.end.split(':');
      const expiry = new Date(now);
      expiry.setHours(parseInt(endParts[0]), parseInt(endParts[1]) + 1, 0, 0);
      if (expiry <= now) {
        expiry.setMinutes(now.getMinutes() + 5);
      }
      
      await Passcode.deleteMany({ key, type: 'single_lecture' });
      const newPasscode = new Passcode({
        passcode,
        type,
        key,
        expiresAt: expiry
      });
      await newPasscode.save();
      await Passcode.deleteMany({ type, expiresAt: { $lt: new Date() } });
      
      return res.json({ message: 'Passcode generated for lecture', passcode, type, expiresAt: expiry });
    }
    
    if (type === 'full_day') {
      await Passcode.deleteMany({ type: 'full_day' });
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      const newPasscode = new Passcode({
        passcode,
        type,
        key: 'full_day_' + Date.now(),
        expiresAt
      });
      await newPasscode.save();
      return res.json({ message: 'Full Day passcode generated', passcode, type, expiresAt });
    }
    
    res.status(400).json({ error: 'Invalid type' });
  } catch (err) {
    console.error('Passcode error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== GET CURRENT PASSCODE ==========
app.get('/api/admin/current-passcode/:type/:requesterRollNo', async (req, res) => {
  try {
    const { type, requesterRollNo } = req.params;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'User not found' });
    if (requester.role !== 'admin' && requester.role !== 'faculty') {
      return res.status(403).json({ error: 'Access Denied' });
    }
    if (type !== 'single_lecture') {
      return res.status(400).json({ error: 'Only single_lecture type supported for current passcode' });
    }
    const branch = requester.branch || 'CSE';
    const period = getCurrentPeriod(branch);
    if (!period) {
      return res.json({ passcode: null, message: 'No active lecture period' });
    }
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const key = `single_lecture_${dateStr}_${period.start}`;
    const passcodeDoc = await Passcode.findOne({ key, type: 'single_lecture', expiresAt: { $gt: new Date() } });
    if (passcodeDoc) {
      return res.json({ passcode: passcodeDoc.passcode, expiresAt: passcodeDoc.expiresAt });
    } else {
      return res.json({ passcode: null, message: 'No passcode generated for current period' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== STUDENT MARKS ATTENDANCE WITH PASSCODE ==========
app.post('/api/attendance/mark-lecture', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, passcode } = req.body;
    if (!rollNo || !subject || !passcode) {
      return res.status(400).json({ error: 'Missing required fields: rollNo, subject, passcode' });
    }
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) {
      return res.status(400).json({ error: dateStatus.message });
    }
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: blockCheck.message });
    }
    
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const branch = user.branch || 'CSE';
    const currentPeriod = getCurrentPeriod(branch);
    if (!currentPeriod) {
      return res.status(400).json({ error: 'No active lecture period right now.' });
    }
    if (currentPeriod.subject !== subject) {
      return res.status(400).json({ error: 'Subject does not match the current lecture.' });
    }
    const key = `single_lecture_${todayDate}_${currentPeriod.start}`;
    const passcodeDoc = await Passcode.findOne({ 
      key, 
      type: 'single_lecture', 
      passcode: passcode, 
      expiresAt: { $gt: new Date() } 
    });
    if (!passcodeDoc) {
      return res.status(400).json({ error: 'Invalid or expired passcode.' });
    }
    
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll);
      return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    }
    
    try {
      const attendance = new Attendance({
        rollNo: cleanRoll,
        studentName: user.name,
        subject,
        date: todayDate,
        status: 'Present',
        location: { latitude, longitude },
        ipAddress: req.ip,
        isVerified: true,
        branch: branch
      });
      await attendance.save();
    } catch (err) {
      if (err.code === 11000) {
        return res.status(400).json({ error: `Already marked for ${subject} today.` });
      }
      throw err;
    }
    
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) {
    console.error('Mark lecture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== FULL DAY ATTENDANCE (Branch-aware) WITH PASSCODE ==========
app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude, passcode } = req.body;
    if (!passcode) {
      return res.status(400).json({ error: 'Full Day passcode required!' });
    }
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    
    const passcodeDoc = await Passcode.findOne({
      passcode: passcode.trim(),
      type: 'full_day',
      expiresAt: { $gt: new Date() }
    });
    if (!passcodeDoc) {
      return res.status(400).json({ error: 'Invalid or expired Full Day passcode.' });
    }
    
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) {
      await incrementFailedAttempts(cleanRoll);
      return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    }
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[today.getDay()];
    const allSubjects = timetable[dayName] || [];
    const academicSubjectSet = new Set();
    allSubjects.forEach(entry => {
      const sub = entry.subject;
      if (!sub.includes("LIB") && !sub.includes("Library") && !sub.includes("Sports")) {
        academicSubjectSet.add(sub);
      }
    });
    const academicSubjects = Array.from(academicSubjectSet);
    
    const existingRecords = await Attendance.find({
      rollNo: cleanRoll,
      date: todayDate,
      subject: { $in: academicSubjects }
    });
    const existingSubjectSet = new Set(existingRecords.map(r => r.subject));
    
    let markedCount = 0;
    let skippedCount = 0;
    const newAttendances = [];
    for (const sub of academicSubjects) {
      if (!existingSubjectSet.has(sub)) {
        newAttendances.push({
          rollNo: cleanRoll,
          studentName: name,
          subject: sub,
          date: todayDate,
          status: 'Present',
          location: { latitude, longitude },
          ipAddress: req.ip,
          isVerified: true,
          branch: branch
        });
        markedCount++;
      } else {
        skippedCount++;
      }
    }
    
    if (newAttendances.length > 0) {
      await Attendance.insertMany(newAttendances);
    }
    
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0;
    user.blockUntil = null;
    await user.save();
    
    if (markedCount === 0 && skippedCount > 0) {
      return res.status(400).json({ error: `All ${skippedCount} academic subjects already marked today!` });
    }
    if (markedCount === 0) {
      return res.status(400).json({ error: 'No academic subjects found for today.' });
    }
    res.status(201).json({ message: `✅ Full Day Marked (${markedCount} new lectures, ${skippedCount} already marked)!` });
  } catch (err) {
    console.error('Full Day error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== STUDENT ATTENDANCE MARKING (without passcode) ==========
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
    if (!locCheck.isInside) { await incrementFailedAttempts(cleanRoll); return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` }); }
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
      isVerified: true,
      branch: user.branch || 'CSE'
    }).save();
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) { console.error('Attendance error:', err); res.status(500).json({ error: err.message }); }
});

// ========== NOTICES ==========
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 }).limit(10);
    res.json(notices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!message || message.trim() === "") { await Notice.deleteMany({}); return res.json({ message: 'Notices cleared!' }); }
    const newNotice = await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Notice published!', notice: newNotice });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HOLIDAYS ==========
app.post('/api/admin/holiday', async (req, res) => {
  try {
    const { requesterRollNo, date, reason } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const parts = date.split('-');
    const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dateObj < SEMESTER_START) return res.status(400).json({ error: 'Cannot declare holiday before 15 July 2026!' });
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[dateObj.getDay()];
    if (dayName === 'Saturday' || dayName === 'Sunday') return res.status(400).json({ error: 'Cannot declare holiday on weekend (Saturday/Sunday)!' });
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

// ========== DASHBOARD STATS (Admin) ==========
app.get('/api/admin/dashboard-stats/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const totalStudents = await User.countDocuments({ role: 'student' });
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0];
    const todayPresentStudents = await Attendance.distinct('rollNo', { date: todayDate, status: 'Present' });
    const todayPresent = todayPresentStudents.length;
    const presentStudentDetails = await Attendance.find({ date: todayDate, status: 'Present' }).select('rollNo studentName').lean();
    const uniquePresent = {};
    presentStudentDetails.forEach(s => { if (!uniquePresent[s.rollNo]) uniquePresent[s.rollNo] = { rollNo: s.rollNo, name: s.studentName }; });
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
    res.json({ totalStudents, todayPresent, todayAbsent, overallAttendance: totalAttendance, overallPct, todayPresentStudents: presentList, workingDaysSoFar, totalWorkingDaysSemester });
  } catch (err) { console.error('Dashboard stats error:', err); res.status(500).json({ error: err.message }); }
});

// ========== ALL USERS (Admin) ==========
app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const users = await User.find().select('name rollNo role boundDeviceId email phone semester branch profilePic facultySubject').sort({ rollNo: 1 });
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ALL FACULTY (Admin) ==========
app.get('/api/admin/faculty/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const faculty = await User.find({ role: 'faculty' }).select('name rollNo email phone facultySubject').sort({ rollNo: 1 });
    res.json(faculty);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== STUDENT ATTENDANCE (Admin/Teacher view) ==========
app.get('/api/attendance/student/:rollNo/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied' });
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    let records = await Attendance.find({ rollNo: cleanRoll }).sort({ date: -1 });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      records = records.filter(r => subjects.includes(r.subject));
    }
    records = records.map(r => {
      r.subject = getFullSubjectName(r.subject);
      return r;
    });
    res.json(records);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DELETE ATTENDANCE RECORD (Admin & Teacher) ==========
app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied: Admin or Teacher only!' });
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      if (!subjects.includes(record.subject)) {
        return res.status(403).json({ error: 'Not authorized to delete this record.' });
      }
    }
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DELETE ALL ATTENDANCE FOR A DATE (Admin & Teacher) ==========
app.delete('/api/attendance/delete-day/:rollNo/:date/:requesterRollNo', async (req, res) => {
  try {
    const { rollNo, date, requesterRollNo } = req.params;
    const cleanRoll = rollNo.trim().toUpperCase();
    const cleanDate = date.trim();
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied: Admin or Teacher only!' });

    let query = { rollNo: cleanRoll, date: cleanDate };
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      query.subject = { $in: subjects };
    }
    const result = await Attendance.deleteMany(query);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'No records found for this date.' });
    res.json({ message: `Deleted ${result.deletedCount} records for ${cleanRoll} on ${cleanDate}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== STUDENT MONTHLY SUMMARY (Branch-aware) ==========
app.get('/api/student/monthly-summary/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const { month } = req.query;
    if (month === undefined || isNaN(parseInt(month))) return res.status(400).json({ error: 'Month parameter (0-11) required' });
    const m = parseInt(month);
    if (m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' });
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const year = 2026;
    const startDate = new Date(year, m, 1);
    const endDate = new Date(year, m + 1, 0);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const records = await Attendance.find({ rollNo: cleanRoll, date: { $gte: startStr, $lte: endStr } }).lean();
    const subjectSet = new Set();
    let totalConducted = 0;
    let cur = new Date(startDate);
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const holidaySet = new Set((await Holiday.find({ date: { $gte: startStr, $lte: endStr } })).map(h => h.date));
    while (cur <= endDate) {
      const dateStr = cur.toISOString().split('T')[0];
      const dayOfWeek = cur.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dayOfWeek];
        const subjects = timetable[dayName] || [];
        subjects.forEach(entry => {
          const sub = entry.subject;
          if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) {
            subjectSet.add(sub);
            totalConducted++;
          }
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    const subjectStats = {};
    subjectSet.forEach(sub => { subjectStats[sub] = { total: 0, present: 0 }; });
    cur = new Date(startDate);
    while (cur <= endDate) {
      const dateStr = cur.toISOString().split('T')[0];
      const dayOfWeek = cur.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dayOfWeek];
        const subjects = timetable[dayName] || [];
        subjects.forEach(entry => {
          const sub = entry.subject;
          if (subjectStats[sub]) subjectStats[sub].total++;
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    records.forEach(rec => {
      const fullSub = getFullSubjectName(rec.subject);
      if (subjectStats[fullSub] && (rec.status === 'Present' || rec.status === 'Duty Leave')) {
        subjectStats[fullSub].present++;
      }
    });
    let totalAttended = 0;
    Object.values(subjectStats).forEach(st => totalAttended += st.present);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const presentDays = new Set(records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').map(r => r.date));
    const subjectStatsWithPct = {};
    Object.keys(subjectStats).forEach(sub => {
      const st = subjectStats[sub];
      subjectStatsWithPct[sub] = {
        total: st.total,
        present: st.present,
        percentage: st.total > 0 ? Math.round((st.present / st.total) * 100) : 0
      };
    });
    res.json({
      totalConducted,
      totalAttended,
      attendancePercentage: pct,
      daysPresent: presentDays.size,
      subjectStats: subjectStatsWithPct
    });
  } catch (err) {
    console.error('Monthly summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== MANUAL ATTENDANCE (Admin) – with branch validation ==========
app.post('/api/admin/manual-attendance-bulk', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, subjects, status, branch } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const parts = date.split('-');
    const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dateObj < SEMESTER_START) return res.status(400).json({ error: 'Cannot mark attendance before 15 July 2026!' });
    const dateStatus = await checkDateStatus(date);
    if (dateStatus.isBlocked) return res.status(400).json({ error: `Cannot mark attendance on ${dateStatus.type}: ${dateStatus.message}` });
    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll No ${targetRoll} not registered!` });
    
    if (branch) {
      const studentBranch = user.branch || 'CSE';
      if (branch.toUpperCase() !== studentBranch.toUpperCase()) {
        return res.status(400).json({ error: `Branch mismatch! Student is in ${studentBranch}, but selected ${branch}. Please select correct branch.` });
      }
    }
    
    let markedCount = 0, markedSubjects = [], alreadyMarked = [];
    const actualBranch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(actualBranch);
    let subjectsToMark = subjects;
    if (!subjectsToMark || subjectsToMark.length === 0) {
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[dateObj.getDay()];
      const allSubjects = timetable[dayName] || [];
      subjectsToMark = allSubjects.filter(entry => !entry.subject.includes("LIB") && !entry.subject.includes("Library") && !entry.subject.includes("Sports")).map(entry => entry.subject);
    }
    const uniqueSubjects = [...new Set(subjectsToMark)];
    for (let sub of uniqueSubjects) {
      const fullSub = getFullSubjectName(sub);
      const existing = await Attendance.findOne({ rollNo: targetRoll, subject: fullSub, date });
      if (existing) {
        alreadyMarked.push(fullSub);
        continue;
      }
      const attendance = new Attendance({
        rollNo: targetRoll,
        studentName: user.name,
        subject: fullSub,
        date,
        status: status || 'Present',
        location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
        ipAddress: 'admin-manual',
        isVerified: true,
        branch: actualBranch
      });
      await attendance.save();
      markedCount++;
      markedSubjects.push(fullSub);
    }
    let message = `✅ Marked ${markedCount} lectures for ${user.name} on ${date}`;
    if (alreadyMarked.length > 0) message += `. Already marked: ${alreadyMarked.join(', ')}`;
    res.status(201).json({ message, markedSubjects, alreadyMarked, total: markedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== HISTORY (Student) ==========
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const records = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    const mapped = records.map(r => {
      r.subject = getFullSubjectName(r.subject);
      return r;
    });
    res.json(mapped);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ALL ATTENDANCE (Admin/Teacher) ==========
app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied: Admin or Teacher only!' });
    let allRecords;
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      allRecords = await Attendance.find({ subject: { $in: subjects } }).sort({ rollNo: 1, date: -1 });
    } else {
      allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    }
    allRecords = allRecords.map(r => {
      r.subject = getFullSubjectName(r.subject);
      return r;
    });
    res.json(allRecords);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== STUDENT SUMMARY (Overall) ==========
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo: cleanRoll }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date));
    const today = new Date();
    const semesterStart = new Date(2026, 6, 15);
    let current = new Date(semesterStart);
    let totalConductedAcademicSubjects = 0;
    const academicDaysSet = new Set();
    const subjectStats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcademicSubjects = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subjects = timetable[dayName] || [];
      const academic = subjects.filter(entry => !entry.subject.includes("LIB") && !entry.subject.includes("Library") && !entry.subject.includes("Sports"));
      dayAcademicSubjects[dayName] = academic.map(entry => entry.subject);
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
        academicSubjects.forEach(sub => {
          if (!subjectStats[sub]) subjectStats[sub] = { total: 0, present: 0 };
          subjectStats[sub].total = (subjectStats[sub].total || 0) + 1;
        });
      }
      current.setDate(current.getDate() + 1);
    }
    const presentDaysSet = new Set();
    const subjectPresentCount = {};
    allRecords.forEach(rec => {
      const sub = getFullSubjectName(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        if (!subjectPresentCount[sub]) subjectPresentCount[sub] = 0;
        subjectPresentCount[sub] = (subjectPresentCount[sub] || 0) + 1;
        presentDaysSet.add(rec.date);
      }
    });
    Object.keys(subjectPresentCount).forEach(sub => {
      if (subjectStats[sub]) subjectStats[sub].present = subjectPresentCount[sub];
    });
    let totalAcademicLecturesAttended = 0;
    Object.values(subjectPresentCount).forEach(v => totalAcademicLecturesAttended += v);
    const pct = totalConductedAcademicSubjects > 0 ? Math.round((totalAcademicLecturesAttended / totalConductedAcademicSubjects) * 100) : 0;
    const daysPresent = presentDaysSet.size;
    const totalWorkingDays = academicDaysSet.size;
    const daysAbsent = totalWorkingDays - daysPresent;
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
  } catch (err) { console.error('Summary error:', err); res.status(500).json({ error: err.message }); }
});

// ========== EXPORT ROUTES ==========
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csv = 'Roll No,Student Name,Subject,Date,Status,IP Address,Location\n';
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csv += `${r.rollNo},${r.studentName},${getFullSubjectName(r.subject)},${r.date},${r.status},${r.ipAddress || 'N/A'},${loc}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/student-attendance/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied: Admin or Teacher only!' });
    const { studentRollNo, range, month } = req.query;
    if (!studentRollNo) return res.status(400).json({ error: 'studentRollNo is required' });
    const cleanStudent = studentRollNo.trim().toUpperCase();
    const today = new Date();
    let startDate, endDate;
    if (range === 'CURRENT_MONTH') { startDate = new Date(today.getFullYear(), today.getMonth(), 1); endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (range === 'SELECTED_MONTH') { const m = parseInt(month); if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' }); startDate = new Date(2026, m, 1); endDate = new Date(2026, m + 1, 0); }
    else { startDate = new Date(SEMESTER_START); endDate = new Date(SEMESTER_END); }
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    let records = await Attendance.find({ rollNo: cleanStudent, date: { $gte: startStr, $lte: endStr } }).sort({ date: 1 });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      records = records.filter(r => subjects.includes(r.subject));
    }
    if (records.length === 0) return res.status(404).json({ error: 'No records found for this student in the selected range.' });
    const studentName = records[0].studentName || 'Unknown';
    let csv = `Student Attendance Report\nStudent: ${studentName} (${cleanStudent})\nRange: ${startStr} to ${endStr}\nGenerated: ${new Date().toLocaleString()}\n\nDate,Subject,Status,Location,IP Address\n`;
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csv += `${r.date},${getFullSubjectName(r.subject)},${r.status},${loc},${r.ipAddress || 'N/A'}\n`;
    });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csv += `\nTotal Lectures: ${total}, Present: ${present}, Attendance %: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cleanStudent}_${range}.csv`);
    res.send(csv);
  } catch (err) { console.error('Student export error:', err); res.status(500).json({ error: err.message }); }
});

// ========== SUBJECT DROPDOWN API ==========
app.get('/api/timetable/subjects', async (req, res) => {
  try {
    const cseSubjects = new Set();
    const aidsSubjects = new Set();
    const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    allDays.forEach(day => {
      CSE_TIME_TABLE[day].forEach(entry => cseSubjects.add(entry.subject));
      AIDS_TIME_TABLE[day].forEach(entry => aidsSubjects.add(entry.subject));
    });
    const all = [...new Set([...cseSubjects, ...aidsSubjects])].sort();
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== TIMETABLE FACULTY LIST ==========
app.get('/api/timetable/faculty', async (req, res) => {
  try {
    const faculty = getTimetableFaculty();
    res.json(faculty);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== CLASS ATTENDANCE REPORT (Admin) – WITH BRANCH FILTER ==========
app.get('/api/admin/class-attendance-report', async (req, res) => {
  try {
    const { requesterRollNo, startDate, endDate, branch } = req.query;
    if (!requesterRollNo) return res.status(400).json({ error: 'requesterRollNo required' });
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
    const end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    
    let query = { role: 'student' };
    if (branch && branch !== 'ALL' && branch !== 'undefined' && branch !== 'null') {
      query.branch = branch.toUpperCase();
    }
    const students = await User.find(query).select('rollNo name branch');
    if (students.length === 0) return res.json({ students: [], totalLectures: 0 });
    
    const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
    const holidaySet = new Set(holidays.map(h => h.date));
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    
    const resultStudents = await Promise.all(students.map(async (student) => {
      const branch = student.branch || 'CSE';
      const timetable = getTimetableForBranch(branch);
      let totalConducted = 0;
      let cur = new Date(start);
      while (cur <= end) {
        const dateStr = cur.toISOString().split('T')[0];
        const dayOfWeek = cur.getDay();
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
        const isHoliday = holidaySet.has(dateStr);
        if (!isWeekend && !isHoliday) {
          const dayName = dayNameMap[dayOfWeek];
          const subjects = timetable[dayName] || [];
          subjects.forEach(entry => {
            const sub = entry.subject;
            if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) {
              totalConducted++;
            }
          });
        }
        cur.setDate(cur.getDate() + 1);
      }
      
      const presentCount = await Attendance.countDocuments({
        rollNo: student.rollNo,
        date: { $gte: startStr, $lte: endStr },
        status: { $in: ['Present', 'Duty Leave'] },
        subject: { $nin: [/Sports/i, /LIB/i, /Library/i] }
      });
      
      return {
        rollNo: student.rollNo,
        name: student.name,
        branch: branch,
        totalPresent: presentCount,
        totalLectures: totalConducted,
        percentage: totalConducted > 0 ? Math.round((presentCount / totalConducted) * 100) : 0
      };
    }));
    
    resultStudents.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
    
    let overallTotal = 0;
    if (resultStudents.length > 0) {
      overallTotal = resultStudents[0].totalLectures;
    }
    
    res.json({
      students: resultStudents,
      totalLectures: overallTotal
    });
  } catch (err) {
    console.error('Class report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== BULK REGISTRATION & ATTENDANCE – CSE ==========
app.post('/api/admin/bulk-register-and-update-attendance', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }

    const studentData = [
      { rollNo: '24CSE01', name: 'AAKASH RAJ CHAUHAN', present: 35 },
      { rollNo: '24CSE03', name: 'ABHISHEK VERMA', present: 0 },
      { rollNo: '24CSE04', name: 'ANKIT KUMAR', present: 0 },
      { rollNo: '24CSE06', name: 'ANSHIKA', present: 44 },
      { rollNo: '24CSE08', name: 'ANUJ TIWARI', present: 0 },
      { rollNo: '24CSE09', name: 'ASHISH KUMAR', present: 47 },
      { rollNo: '24CSE11', name: 'B DEVIKA', present: 0 },
      { rollNo: '24CSE14', name: 'GAUTAM', present: 35 },
      { rollNo: '24CSE15', name: 'HARSH RAJ', present: 11 },
      { rollNo: '24CSE16', name: 'HIMANSHI', present: 38 },
      { rollNo: '24CSE18', name: 'HITESH YADAV', present: 0 },
      { rollNo: '24CSE19', name: 'ISHANT KUMAR', present: 44 },
      { rollNo: '24CSE20', name: 'JATIN', present: 0 },
      { rollNo: '24CSE21', name: 'JATIN YADAV', present: 0 },
      { rollNo: '24CSE22', name: 'JITIN YADAV', present: 0 },
      { rollNo: '24CSE23', name: 'KAUSHAL KUMAR', present: 18 },
      { rollNo: '24CSE24', name: 'KRISH BHARDWAJ', present: 1 },
      { rollNo: '24CSE25', name: 'MANISH', present: 0 },
      { rollNo: '24CSE27', name: 'MANMOHAN KUMAR', present: 0 },
      { rollNo: '24CSE28', name: 'MANOJ', present: 5 },
      { rollNo: '24CSE29', name: 'MAYANK', present: 0 },
      { rollNo: '24CSE30', name: 'MD SAMIR ALAM', present: 0 },
      { rollNo: '24CSE31', name: 'MUDIT BEDI', present: 8 },
      { rollNo: '24CSE33', name: 'NEHA SHUKLA', present: 39 },
      { rollNo: '24CSE35', name: 'PRASHANT', present: 0 },
      { rollNo: '24CSE36', name: 'PREETI', present: 39 },
      { rollNo: '24CSE37', name: 'PURAV RAO', present: 1 },
      { rollNo: '24CSE38', name: 'RACHIT SINGH', present: 0 },
      { rollNo: '24CSE39', name: 'RAHUL', present: 0 },
      { rollNo: '24CSE40', name: 'RISHAV RAJ', present: 0 },
      { rollNo: '24CSE41', name: 'RITU KUMARI', present: 18 },
      { rollNo: '24CSE42', name: 'ROHIT SHRESTA', present: 43 },
      { rollNo: '24CSE43', name: 'RUPESH KUMAR', present: 0 },
      { rollNo: '24CSE44', name: 'SAHIL', present: 0 },
      { rollNo: '24CSE45', name: 'SAIESH', present: 0 },
      { rollNo: '24CSE46', name: 'SAKSHI KUMARI', present: 21 },
      { rollNo: '24CSE47', name: 'SOURABH RAJPUT', present: 0 },
      { rollNo: '24CSE48', name: 'SUMIT SHARMA', present: 12 },
      { rollNo: '24CSE49', name: 'TUSHAR KUMAR', present: 44 },
      { rollNo: '24CSE51', name: 'VIDHI BHARGAV', present: 22 },
      { rollNo: '24CSE52', name: 'VINAY', present: 32 }
    ];

    const startDate = new Date(2026, 6, 15);
    const endDate = new Date(2026, 6, 30);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    let totalRegistered = 0, totalAttendanceAdded = 0;

    for (const item of studentData) {
      const roll = item.rollNo;
      const name = item.name;
      const presentNeeded = item.present;

      let user = await User.findOne({ rollNo: roll });
      if (user) {
        user.name = name;
        user.branch = 'CSE';
        user.password = await bcrypt.hash('123456', 10);
        await user.save();
      } else {
        const hashedPassword = await bcrypt.hash('123456', 10);
        const newUser = new User({
          name: name,
          rollNo: roll,
          password: hashedPassword,
          role: 'student',
          branch: 'CSE',
          boundDeviceId: null
        });
        await newUser.save();
        user = newUser;
        totalRegistered++;
      }

      await Attendance.deleteMany({
        rollNo: roll,
        date: { $gte: startStr, $lte: endStr }
      });

      if (presentNeeded === 0) continue;

      let days = [];
      let cur = new Date(startDate);
      while (cur <= endDate) {
        const dateStr = cur.toISOString().split('T')[0];
        const dayOfWeek = cur.getDay();
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
        const isHoliday = await Holiday.findOne({ date: dateStr });
        if (!isWeekend && !isHoliday) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dayOfWeek];
          const timetable = getTimetableForBranch('CSE');
          const subjects = timetable[dayName] || [];
          const academicSubjects = subjects
            .map(s => s.subject)
            .filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: dateStr, subjects: academicSubjects });
        }
        cur.setDate(cur.getDate() + 1);
      }

      let allAvailableSubjects = [];
      for (const d of days) {
        for (const sub of d.subjects) {
          allAvailableSubjects.push({ date: d.date, subject: sub });
        }
      }

      const toMark = Math.min(presentNeeded, allAvailableSubjects.length);
      for (let i = 0; i < toMark; i++) {
        const entry = allAvailableSubjects[i];
        await new Attendance({
          rollNo: roll,
          studentName: name,
          subject: entry.subject,
          date: entry.date,
          status: 'Present',
          location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
          ipAddress: 'bulk-update',
          isVerified: true,
          branch: 'CSE'
        }).save();
        totalAttendanceAdded++;
      }
    }

    res.json({
      message: 'CSE Bulk registration and attendance update completed!',
      totalRegistered,
      totalAttendanceAdded
    });

  } catch (err) {
    console.error('CSE Bulk update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== BULK REGISTRATION & ATTENDANCE – AIDS ==========
app.post('/api/admin/bulk-register-and-update-attendance-aids', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }

    const studentData = [
      { rollNo: '24AIDS01', name: 'AKASH', present: 1 },
      { rollNo: '24AIDS03', name: 'DAVANSH SINGH KARKI', present: 5 },
      { rollNo: '24AIDS04', name: 'FAIZAN AHMAD', present: 40 },
      { rollNo: '24AIDS05', name: 'GOPESH JHA', present: 0 },
      { rollNo: '24AIDS06', name: 'HEMANT YADAV', present: 0 },
      { rollNo: '24AIDS07', name: 'HUSNAIN AHMAD', present: 40 },
      { rollNo: '24AIDS08', name: 'JANHVI', present: 0 },
      { rollNo: '24AIDS09', name: 'JYOTI PUSHPA ROUT', present: 26 },
      { rollNo: '24AIDS11', name: 'MAHIMA', present: 38 },
      { rollNo: '24AIDS12', name: 'MOHAMMAD HAMID KHALIL', present: 0 },
      { rollNo: '24AIDS13', name: 'PIYUSH KUMAR', present: 0 },
      { rollNo: '24AIDS14', name: 'PRINCE KUMAR', present: 0 },
      { rollNo: '24AIDS16', name: 'SACHIN', present: 0 },
      { rollNo: '24AIDS17', name: 'SAHIL PRASAD', present: 5 },
      { rollNo: '24AIDS19', name: 'VINAY', present: 38 }
    ];

    const startDate = new Date(2026, 6, 15);
    const endDate = new Date(2026, 6, 30);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    let totalRegistered = 0, totalAttendanceAdded = 0;

    for (const item of studentData) {
      const roll = item.rollNo;
      const name = item.name;
      const presentNeeded = item.present;

      let user = await User.findOne({ rollNo: roll });
      if (user) {
        user.name = name;
        user.branch = 'AIDS';
        user.password = await bcrypt.hash('123456', 10);
        await user.save();
      } else {
        const hashedPassword = await bcrypt.hash('123456', 10);
        const newUser = new User({
          name: name,
          rollNo: roll,
          password: hashedPassword,
          role: 'student',
          branch: 'AIDS',
          boundDeviceId: null
        });
        await newUser.save();
        user = newUser;
        totalRegistered++;
      }

      await Attendance.deleteMany({
        rollNo: roll,
        date: { $gte: startStr, $lte: endStr }
      });

      if (presentNeeded === 0) continue;

      let days = [];
      let cur = new Date(startDate);
      while (cur <= endDate) {
        const dateStr = cur.toISOString().split('T')[0];
        const dayOfWeek = cur.getDay();
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
        const isHoliday = await Holiday.findOne({ date: dateStr });
        if (!isWeekend && !isHoliday) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dayOfWeek];
          const timetable = getTimetableForBranch('AIDS');
          const subjects = timetable[dayName] || [];
          const academicSubjects = subjects
            .map(s => s.subject)
            .filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: dateStr, subjects: academicSubjects });
        }
        cur.setDate(cur.getDate() + 1);
      }

      let allAvailableSubjects = [];
      for (const d of days) {
        for (const sub of d.subjects) {
          allAvailableSubjects.push({ date: d.date, subject: sub });
        }
      }

      const toMark = Math.min(presentNeeded, allAvailableSubjects.length);
      for (let i = 0; i < toMark; i++) {
        const entry = allAvailableSubjects[i];
        await new Attendance({
          rollNo: roll,
          studentName: name,
          subject: entry.subject,
          date: entry.date,
          status: 'Present',
          location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
          ipAddress: 'bulk-update',
          isVerified: true,
          branch: 'AIDS'
        }).save();
        totalAttendanceAdded++;
      }
    }

    res.json({
      message: 'AIDS Bulk registration and attendance update completed!',
      totalRegistered,
      totalAttendanceAdded
    });

  } catch (err) {
    console.error('AIDS Bulk update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATED: BULK MARK ATTENDANCE (Admin) – supports specific dates ==========
app.post('/api/admin/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, subjects } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    if (!studentRollNos || !Array.isArray(studentRollNos) || studentRollNos.length === 0) {
      return res.status(400).json({ error: 'At least one student roll number required.' });
    }
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'At least one date required.' });
    }
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ error: `Invalid date format: ${d}. Use YYYY-MM-DD.` });
      }
    }
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    if (students.length === 0) return res.status(404).json({ error: 'No valid students found.' });

    const results = [];
    for (const student of students) {
      const branch = student.branch || 'CSE';
      const timetable = getTimetableForBranch(branch);
      let markedCount = 0;
      let skippedCount = 0;
      for (const date of dates) {
        const dateStatus = await checkDateStatus(date);
        if (dateStatus.isBlocked) continue;
        const dayName = dateStatus.dayName;
        let daySubjects = timetable[dayName] || [];
        let subjectsToMark = subjects && subjects.length > 0 ? subjects : daySubjects.map(s => s.subject);
        const uniqueSubjects = [...new Set(subjectsToMark.filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports')))];
        for (const sub of uniqueSubjects) {
          const exists = await Attendance.findOne({ rollNo: student.rollNo, subject: sub, date });
          if (!exists) {
            await new Attendance({
              rollNo: student.rollNo,
              studentName: student.name,
              subject: sub,
              date,
              status: 'Present',
              location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
              ipAddress: 'bulk-mark',
              isVerified: true,
              branch: branch
            }).save();
            markedCount++;
          } else {
            skippedCount++;
          }
        }
      }
      results.push({ rollNo: student.rollNo, marked: markedCount, skipped: skippedCount });
    }

    const totalMarked = results.reduce((sum, r) => sum + r.marked, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
    res.json({ message: `✅ Bulk mark completed. Marked ${totalMarked} new records, skipped ${totalSkipped} existing.`, results });
  } catch (err) {
    console.error('Bulk mark error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== UPDATED: BULK DELETE ATTENDANCE (Admin) – supports specific dates ==========
app.delete('/api/admin/bulk-delete-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') {
      return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    }
    if (!studentRollNos || !Array.isArray(studentRollNos) || studentRollNos.length === 0) {
      return res.status(400).json({ error: 'At least one student roll number required.' });
    }
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'At least one date required.' });
    }
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ error: `Invalid date format: ${d}. Use YYYY-MM-DD.` });
      }
    }

    const result = await Attendance.deleteMany({
      rollNo: { $in: studentRollNos },
      date: { $in: dates }
    });
    res.json({ message: `✅ Deleted ${result.deletedCount} attendance records.` });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHAT MANAGEMENT ENDPOINTS ====================

// Get all chat threads for a user
app.get('/api/chats/:rollNo', async (req, res) => {
  try {
    const { rollNo } = req.params;
    const cleanRoll = rollNo.trim().toUpperCase();
    const chats = await Chat.find({ rollNo: cleanRoll }).sort({ updatedAt: -1 });
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new chat thread (or update existing)
app.post('/api/chats', async (req, res) => {
  try {
    const { rollNo, threadId, title, messages } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    if (!threadId) {
      const newThreadId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const newChat = new Chat({
        rollNo: cleanRoll,
        threadId: newThreadId,
        title: title || 'New Chat',
        messages: messages || []
      });
      await newChat.save();
      return res.status(201).json(newChat);
    } else {
      const chat = await Chat.findOne({ threadId, rollNo: cleanRoll });
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }
      if (title) chat.title = title;
      if (messages) chat.messages = messages;
      chat.updatedAt = new Date();
      await chat.save();
      return res.json(chat);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a chat thread
app.delete('/api/chats/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { rollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cleanRoll = rollNo.trim().toUpperCase();
    const result = await Chat.findOneAndDelete({ threadId, rollNo: cleanRoll });
    if (!result) return res.status(404).json({ error: 'Chat not found' });
    res.json({ message: 'Chat deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHAT AI ENDPOINT (FIXED) ====================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const cleanRoll = rollNo?.trim().toUpperCase() || 'guest';

    // Fetch user data and context directly (no internal HTTP)
    let userData = null;
    let attendanceSummary = null;
    let workingDays = 0;
    let holidays = [];
    let timetable = {};
    let currentPeriod = null;

    if (cleanRoll !== 'guest') {
      try {
        userData = await User.findOne({ rollNo: cleanRoll });
        if (userData) {
          // Get summary using helper
          attendanceSummary = await getStudentSummary(userData.rollNo);
          const today = new Date();
          const startStr = SEMESTER_START.toISOString().split('T')[0];
          const todayStr = today.toISOString().split('T')[0];
          workingDays = await getWorkingDays(startStr, todayStr);
          holidays = await Holiday.find({ date: { $gte: startStr, $lte: todayStr } });
          const branchName = userData.branch || 'CSE';
          timetable = getBranchTimetable(branchName);
          currentPeriod = getCurrentPeriod(branchName);
        }
      } catch (err) {
        console.error('Error fetching user data for chat:', err);
        // Continue without data
      }
    }

    // Determine greeting based on time
    const now = new Date();
    const hour = now.getHours();
    let greeting = '';
    let emoji = '';
    if (hour < 12) { greeting = 'Good morning'; emoji = '🌞'; }
    else if (hour < 17) { greeting = 'Good afternoon'; emoji = '🌤️'; }
    else { greeting = 'Good evening'; emoji = '🌙'; }

    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';
    const systemPrompt = `You are an AI assistant for BM Group of Institutions attendance portal.
Your name is "BM Bot".
Current date/time: ${now.toLocaleString()}
User: ${userName} (Roll: ${cleanRoll}, Role: ${userRole})
Branch: ${userData?.branch || branch || 'CSE'}

Attendance summary: ${attendanceSummary ? JSON.stringify(attendanceSummary, null, 2) : 'Not available'}
Working days so far (since 15 July 2026): ${workingDays}
Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ') || 'None'}
Today's timetable: ${JSON.stringify(timetable, null, 2)}
Current lecture period: ${currentPeriod ? `${currentPeriod.subject} (${currentPeriod.start} - ${currentPeriod.end})` : 'No class now'}

You have full knowledge of the attendance system, college schedule, and can answer any related queries.
Be friendly, concise, and use emojis where appropriate.
If the user asks for notes, assignments, or study materials, provide a detailed and helpful response with bullet points or sections.
If the user asks for a flowchart, describe it in text using ASCII art or step-by-step instructions.
Always greet the user with ${greeting}, ${userName} ${emoji} at the start of the conversation (unless it's a follow-up within the same thread).
If the user asks for help, provide a list of common commands or questions they can ask.
Do not perform any actions (like marking attendance) – only provide guidance.

Reply in a clear, conversational, and professional manner.`;

    // Manage chat history
    let chatThread = null;
    let existingMessages = [];
    if (threadId && cleanRoll !== 'guest') {
      chatThread = await Chat.findOne({ threadId, rollNo: cleanRoll });
      if (chatThread) {
        existingMessages = chatThread.messages.map(m => ({ role: m.role, content: m.content }));
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...existingMessages,
      { role: 'user', content: message }
    ];

    let reply = '';
    if (!GROK_API_KEY) {
      reply = `${greeting}, ${userName} ${emoji}! I'm your BM Bot. ` +
        `I see you have ${attendanceSummary?.attendancePercentage || 0}% attendance. ` +
        `Working days so far: ${workingDays}. ` +
        `Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ') || 'None'}. ` +
        `How can I assist you today? (Note: Grok API key not set, so I'm using fallback mode.)`;
    } else {
      try {
        const grokPayload = {
          model: 'grok-1',
          messages: messages,
          temperature: 0.7,
          max_tokens: 1000
        };
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROK_API_KEY}`
          },
          body: JSON.stringify(grokPayload)
        });
        if (!response.ok) {
          const errorText = await response.text();
          console.error('Grok API error:', errorText);
          reply = '⚠️ AI service temporarily unavailable. Please try again later.';
        } else {
          const data = await response.json();
          reply = data.choices?.[0]?.message?.content || 'Sorry, I could not understand.';
        }
      } catch (grokErr) {
        console.error('Grok API exception:', grokErr);
        reply = '⚠️ AI service error. Please try again later.';
      }
    }

    // Save conversation to thread (only if user is logged in)
    let newThreadId = threadId;
    if (cleanRoll !== 'guest') {
      const newMessages = [
        ...(existingMessages || []),
        { role: 'user', content: message },
        { role: 'assistant', content: reply }
      ];
      let title = '';
      if (chatThread) {
        chatThread.messages = newMessages;
        chatThread.updatedAt = new Date();
        if (!chatThread.title || chatThread.title === 'New Chat') {
          const firstUserMsg = newMessages.find(m => m.role === 'user');
          if (firstUserMsg) {
            chatThread.title = firstUserMsg.content.substring(0, 50);
          }
        }
        await chatThread.save();
        title = chatThread.title;
        newThreadId = chatThread.threadId;
      } else {
        const firstUserMsg = newMessages.find(m => m.role === 'user');
        const autoTitle = firstUserMsg ? firstUserMsg.content.substring(0, 50) : 'New Chat';
        const newThread = new Chat({
          rollNo: cleanRoll,
          threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          title: autoTitle,
          messages: newMessages
        });
        await newThread.save();
        newThreadId = newThread.threadId;
        title = autoTitle;
        chatThread = newThread;
      }
    }

    res.json({
      reply,
      threadId: newThreadId || null,
      title: chatThread?.title || 'New Chat',
      messages: chatThread?.messages || []
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Internal server error: ' + err.message });
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
