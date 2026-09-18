const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const csv = require('csv-parser');
const { Readable } = require('stream');
const PDFDocument = require('pdfkit');
process.env.TZ = 'Asia/Kolkata';
console.log(`🕐 Server Timezone: ${process.env.TZ}`);

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// ---------- Env ----------
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const COLLEGE_LAT = 28.4509370;
const COLLEGE_LNG = 76.7688120;
const COLLEGE_RADIUS = 100;

const SEMESTER_START = new Date('2026-07-15T00:00:00+05:30');
const SEMESTER_END = new Date('2026-12-31T23:59:59+05:30');

if (!MONGO_URI) { console.error('❌ MONGO_URI missing'); process.exit(1); }
if (!GEMINI_API_KEY) console.warn('⚠️ GEMINI_API_KEY missing');

// ---------- Helpers ----------
function getISTDateString(dateObj) {
  const istDate = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000));
  return istDate.toISOString().split('T')[0];
}

// ---------- Rate Limit ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts, try again after 15 minutes.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Too many requests, please slow down.' } });
app.use('/api/auth/', authLimiter);
app.use('/api/', apiLimiter);

// ---------- Zod ----------
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

function normalizeSubject(subject) { return subject ? subject.replace(/\s+/g, ' ').trim() : ''; }

const SUBJECT_ALIAS_MAP = {
  'BDA - Big Data Analytics': 'BDA - Big Data Analytics',
  'ECO - Economics for Engineers': 'ECO - Economics for Engineers',
  'DAA - Design & Analysis of Algorithm': 'DAA - Design & Analysis of Algorithm',
  'FLA - Formal Language & Automata': 'FLA - Formal Language & Automata',
  'HRM - Human Resource Mgmt': 'HRM - Human Resource Mgmt',
  'CN - Computer Network': 'CN - Computer Network',
  'WT - Web Technology': 'WT - Web Technology',
  'CN LAB - Computer Network Lab': 'CN LAB - Computer Network Lab',
  'DAA LAB - Algorithm Lab': 'DAA LAB - Algorithm Lab',
  'WT LAB - Web Technology Lab': 'WT LAB - Web Technology Lab',
  'Internet Lab (Ms. Geeta)': 'Internet Lab (Ms. Geeta)',
  'PA - Predictive Analysis': 'PA - Predictive Analysis',
  'ML - Machine Learning': 'ML - Machine Learning',
  'PA LAB - Predictive Analysis Lab': 'PA LAB - Predictive Analysis Lab',
  'ML LAB - Machine Learning Lab': 'ML LAB - Machine Learning Lab',
  'BDA LAB - Big Data Analytics Lab': 'BDA LAB - Big Data Analytics Lab',
  'LIB - Library': 'LIB - Library', 'Sports': 'Sports',
  'BDA': 'BDA - Big Data Analytics', 'ECO': 'ECO - Economics for Engineers',
  'DAA': 'DAA - Design & Analysis of Algorithm', 'FLA': 'FLA - Formal Language & Automata',
  'HRM': 'HRM - Human Resource Mgmt', 'CN': 'CN - Computer Network', 'WT': 'WT - Web Technology',
  'CN LAB': 'CN LAB - Computer Network Lab', 'DAA LAB': 'DAA LAB - Algorithm Lab',
  'WT LAB': 'WT LAB - Web Technology Lab', 'Internet': 'Internet Lab (Ms. Geeta)',
  'Internet Lab': 'Internet Lab (Ms. Geeta)', 'PA': 'PA - Predictive Analysis',
  'ML': 'ML - Machine Learning', 'PA LAB': 'PA LAB - Predictive Analysis Lab',
  'ML LAB': 'ML LAB - Machine Learning Lab', 'BDA LAB': 'BDA LAB - Big Data Analytics Lab',
  'LIB': 'LIB - Library'
};

function mapToCanonical(subject) {
  if (!subject) return '';
  const normalized = normalizeSubject(subject);
  if (SUBJECT_ALIAS_MAP[normalized]) return SUBJECT_ALIAS_MAP[normalized];
  const sortedAliases = Object.keys(SUBJECT_ALIAS_MAP).sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    if (normalized === alias) return SUBJECT_ALIAS_MAP[alias];
    if (normalized.startsWith(alias + ' ')) return SUBJECT_ALIAS_MAP[alias];
  }
  for (const alias of sortedAliases) if (normalized.includes(alias)) return SUBJECT_ALIAS_MAP[alias];
  return normalized;
}

// ---------- TIMETABLES ----------
const CSE_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'DAA - Design & Analysis of Algorithm', faculty: 'Ms. Rashmi' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'CN - Computer Network', faculty: 'Mr. Chhetrapal' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Tuesday: [
    { subject: 'WT - Web Technology', faculty: 'Mr. Avish Yadav' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'Internet Lab (Ms. Geeta)', faculty: 'Ms. Geeta' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Wednesday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'Sports / Activity', faculty: 'Sports Dept' },
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
    { subject: 'WT LAB - Web Technology Lab', faculty: 'Mr. Avish Yadav' },
    { subject: 'Sports', faculty: 'Sports Dept' }
  ],
  Saturday: [], Sunday: []
};

const AIDS_TIME_TABLE = {
  Monday: [
    { subject: 'BDA - Big Data Analytics', faculty: 'Ms. Geeta' },
    { subject: 'ECO - Economics for Engineers', faculty: 'Ms. Sakshi Yadav' },
    { subject: 'LIB - Library', faculty: 'Library Staff' },
    { subject: 'FLA - Formal Language & Automata', faculty: 'Ms. Nisha Yadav' },
    { subject: 'HRM - Human Resource Mgmt', faculty: 'Mr. Lokesh' },
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
  ],
  Saturday: [], Sunday: []
};

function getTimetableForBranch(branch) {
  if (branch && branch.toUpperCase() === 'AIDS') return AIDS_TIME_TABLE;
  return CSE_TIME_TABLE;
}

// ---------- Helpers ----------
async function checkDateStatus(dateStr) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dateObj = new Date(dateStr + 'T00:00:00Z');
  const dayName = days[dateObj.getUTCDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return { isBlocked: true, type: 'WEEKEND', message: `📅 ${dayName}: College Closed (Weekend)`, dayName };
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) return { isBlocked: true, type: 'HOLIDAY', message: `🎉 Holiday: ${holiday.reason}`, dayName, holiday: holiday.reason };
  return { isBlocked: false, dayName };
}

async function getWorkingDays(startDate, endDate) {
  const startStr = typeof startDate === 'string' ? startDate : getISTDateString(startDate);
  const endStr = typeof endDate === 'string' ? endDate : getISTDateString(endDate);
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T23:59:59Z');
  let workingDays = 0;
  const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
  const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
  let current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const dayOfWeek = current.getUTCDay();
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    if (!isWeekend && !holidaySet.has(dateStr)) workingDays++;
    current.setUTCDate(current.getUTCDate() + 1);
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
  if (!lat || !lng || lat === 0 || lng === 0) return { isInside: false, distance: "GPS Disconnected" };
  const distance = calculateDistance(lat, lng, COLLEGE_LAT, COLLEGE_LNG);
  return { isInside: distance <= COLLEGE_RADIUS, distance: distance.toFixed(0) };
}
async function checkStudentBlocked(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return { blocked: false };
  if (user.blockUntil && user.blockUntil > new Date()) return { blocked: true, message: `⛔ Blocked until ${user.blockUntil.toLocaleString()}. Contact Admin.` };
  if (user.blockUntil && user.blockUntil <= new Date()) { user.failedAttempts = 0; user.blockUntil = null; await user.save(); }
  return { blocked: false };
}
async function incrementFailedAttempts(rollNo) {
  const user = await User.findOne({ rollNo });
  if (!user) return;
  user.failedAttempts = (user.failedAttempts || 0) + 1;
  if (user.failedAttempts >= 5) { user.blockUntil = new Date(Date.now() + 60 * 60 * 1000); console.log(`🚫 ${rollNo} blocked`); }
  await user.save();
}
async function generateTeacherId(subject) {
  const SUBJECT_CODE_MAP = {
    'BDA - Big Data Analytics': 'BDA', 'ECO - Economics for Engineers': 'ECO',
    'DAA - Design & Analysis of Algorithm': 'DAA', 'FLA - Formal Language & Automata': 'FLA',
    'HRM - Human Resource Mgmt': 'HRM', 'CN - Computer Network': 'CN', 'WT - Web Technology': 'WT',
    'Internet Lab (Ms. Geeta)': 'INT', 'CN LAB - Computer Network Lab': 'CNL',
    'DAA LAB - Algorithm Lab': 'DAAL', 'WT LAB - Web Technology Lab': 'WTL',
    'LIB - Library': 'LIB', 'PA - Predictive Analysis': 'PA', 'ML - Machine Learning': 'ML',
    'PA LAB - Predictive Analysis Lab': 'PAL', 'ML LAB - Machine Learning Lab': 'MLL',
    'BDA LAB - Big Data Analytics Lab': 'BDAL', 'Sports': 'SPT'
  };
  const code = SUBJECT_CODE_MAP[subject] || 'TCH';
  const existing = await User.find({ rollNo: { $regex: `^${code}\\d{2}$` }, role: 'faculty' });
  let maxNum = 0;
  existing.forEach(user => { const num = parseInt(user.rollNo.replace(code, '')); if (num > maxNum) maxNum = num; });
  const newNum = String(maxNum + 1).padStart(2, '0');
  return `${code}${newNum}`;
}

// ---------- Schedule ----------
const CSE_SCHEDULE = {
  1: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "DAA - Design & Analysis of Algorithm", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
    { start: "13:50", end: "14:35", subject: "CN - Computer Network", period: "P7" },
    { start: "14:35", end: "15:20", subject: "Sports", period: "P8" }
  ],
  2: [
    { start: "09:20", end: "10:05", subject: "WT - Web Technology", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "Internet Lab (Ms. Geeta)", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
    { start: "13:50", end: "14:35", subject: "BDA - Big Data Analytics", period: "P7" },
    { start: "14:35", end: "15:20", subject: "Sports", period: "P8" }
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
    { start: "14:35", end: "15:20", subject: "Sports", period: "P8" }
  ]
};

const AIDS_SCHEDULE = {
  1: [
    { start: "09:20", end: "10:05", subject: "BDA - Big Data Analytics", period: "P1" },
    { start: "10:05", end: "10:50", subject: "ECO - Economics for Engineers", period: "P2" },
    { start: "10:50", end: "11:35", subject: "LIB - Library", period: "P3" },
    { start: "11:35", end: "12:20", subject: "FLA - Formal Language & Automata", period: "P4" },
    { start: "12:20", end: "13:05", subject: "Lunch Break", period: "LUNCH" },
    { start: "13:05", end: "13:50", subject: "HRM - Human Resource Mgmt", period: "P6" },
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

function getScheduleForBranch(branch) { return (branch && branch.toUpperCase() === 'AIDS') ? AIDS_SCHEDULE : CSE_SCHEDULE; }

function getCurrentPeriod(branch = 'CSE') {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return null;
  const schedule = getScheduleForBranch(branch);
  const daySchedule = schedule[day] || [];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  for (let slot of daySchedule) {
    const startMins = parseInt(slot.start.split(':')[0]) * 60 + parseInt(slot.start.split(':')[1]);
    const endMins = parseInt(slot.end.split(':')[0]) * 60 + parseInt(slot.end.split(':')[1]);
    if (currentMinutes >= startMins && currentMinutes < endMins) return slot;
  }
  return null;
}

function getTimetableForDate(dateStr, branch = 'CSE') {
  const parts = dateStr.split('-');
  const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[dateObj.getDay()];
  if (dayName === 'Saturday' || dayName === 'Sunday') return [];
  const timetable = getTimetableForBranch(branch);
  return timetable[dayName] || [];
}

// ---------- MongoDB ----------
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
  .then(() => console.log('✅ MongoDB Connected!'))
  .catch(err => { console.error('❌ MongoDB Error:', err.message); process.exit(1); });

// ---------- Schemas ----------
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

const holidaySchema = new mongoose.Schema({ date: { type: String, required: true, unique: true }, reason: { type: String, default: 'College Holiday' } }, { timestamps: true });
const noticeSchema = new mongoose.Schema({ title: String, message: String, date: { type: Date, default: Date.now } });
const passcodeSchema = new mongoose.Schema({ passcode: { type: String, required: true }, type: { type: String, enum: ['full_day', 'single_lecture'], required: true }, key: { type: String, unique: true, sparse: true }, expiresAt: { type: Date, required: true } }, { timestamps: true });
const teacherSubjectSchema = new mongoose.Schema({ teacherRollNo: { type: String, required: true }, subject: { type: String, required: true }, assignedBy: { type: String, required: true }, createdAt: { type: Date, default: Date.now } }, { timestamps: true });
const chatSchema = new mongoose.Schema({
  rollNo: { type: String, required: true },
  threadId: { type: String, required: true, unique: true },
  title: { type: String, default: 'New Chat' },
  messages: [{ role: { type: String, enum: ['user', 'assistant'], required: true }, content: { type: String, required: true }, timestamp: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
});
const leaveSchema = new mongoose.Schema({
  rollNo: { type: String, required: true }, studentName: { type: String, required: true },
  fromDate: { type: String, required: true }, toDate: { type: String, required: true },
  reason: { type: String, required: true },
  leaveType: { type: String, enum: ['Sick','Personal','Event','Other'], default: 'Personal' },
  status: { type: String, enum: ['Pending','Approved','Rejected'], default: 'Pending' },
  reviewedBy: { type: String, default: null }, adminNote: { type: String, default: '' },
  branch: { type: String, default: 'CSE' }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Holiday = mongoose.model('Holiday', holidaySchema);
const Notice = mongoose.model('Notice', noticeSchema);
const Passcode = mongoose.model('Passcode', passcodeSchema);
const TeacherSubject = mongoose.model('TeacherSubject', teacherSubjectSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Leave = mongoose.model('Leave', leaveSchema);
Attendance.createIndexes().catch(err => console.error('Index error:', err));

// ---------- getStudentSummary ----------
async function getStudentSummary(rollNo) {
  try {
    const user = await User.findOne({ rollNo });
    if (!user) return null;
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
    const today = new Date();
    const semesterStart = new Date('2026-07-15T00:00:00+05:30');
    let current = new Date(semesterStart);
    let totalConductedAcademicSubjects = 0;
    const subjectStats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcademicSubjects = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subjects = timetable[dayName] || [];
      const academic = subjects.filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports"));
      dayAcademicSubjects[dayName] = academic.map(e => mapToCanonical(e.subject));
    }
    while (current <= today) {
      const dateStr = getISTDateString(current);
      const dow = current.getDay();
      const isWeekend = (dow === 0 || dow === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dow];
        const acad = dayAcademicSubjects[dayName] || [];
        totalConductedAcademicSubjects += acad.length;
        acad.forEach(sub => {
          if (!subjectStats[sub]) subjectStats[sub] = { total: 0, present: 0 };
          subjectStats[sub].total = (subjectStats[sub].total || 0) + 1;
        });
      }
      current.setDate(current.getDate() + 1);
    }
    const subjectPresentCount = {};
    allRecords.forEach(rec => {
      let sub = mapToCanonical(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        if (!subjectPresentCount[sub]) subjectPresentCount[sub] = 0;
        subjectPresentCount[sub]++;
      }
    });
    Object.keys(subjectPresentCount).forEach(sub => { if (subjectStats[sub]) subjectStats[sub].present = subjectPresentCount[sub]; });
    let totalAttended = 0;
    Object.values(subjectPresentCount).forEach(v => totalAttended += v);
    const pct = totalConductedAcademicSubjects > 0 ? Math.round((totalAttended / totalConductedAcademicSubjects) * 100) : 0;
    const subjectStatsFinal = {};
    for (let [sub, stats] of Object.entries(subjectStats)) {
      subjectStatsFinal[sub] = { present: stats.present || 0, total: stats.total || 0, percentage: stats.total > 0 ? Math.round(((stats.present || 0) / stats.total) * 100) : 0 };
    }
    const daysPresent = allRecords.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
    const workingDaysSoFar = await getWorkingDays(semesterStart, today);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStart, SEMESTER_END);
    return { totalAcademicLectures: totalAttended, totalConductedLectures: totalConductedAcademicSubjects, attendancePercentage: pct, subjectStats: subjectStatsFinal, daysPresent, workingDaysSoFar, totalWorkingDaysSemester };
  } catch (e) { console.error('getStudentSummary error:', e); return null; }
}

// ============================================================
//  AI HELPER: Gemini call (multimodal)
// ============================================================
async function callGemini({ prompt, systemPrompt = null, fileBase64 = null, mimeType = null, history = null, maxTokens = 1500, temperature = 0.7, timeoutMs = 60000 }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const contents = [];
  if (history && Array.isArray(history)) {
    for (const m of history.slice(-10)) {
      if (!m || !m.content) continue;
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
  }
  const userParts = [{ text: prompt }];
  if (fileBase64 && mimeType) userParts.push({ inline_data: { mime_type: mimeType, data: fileBase64 } });
  contents.push({ role: 'user', parts: userParts });
  const payload = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 } };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini ${response.status}: ${errText.substring(0, 300)}`);
    }
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim();
    if (!text) throw new Error('Empty Gemini response. finishReason: ' + (candidate?.finishReason || 'unknown'));
    return text;
  } catch (err) { clearTimeout(timeout); throw err; }
}

// ============================================================
//  PDF HELPER: Generate PDF buffer from structured content
// ============================================================
function generatePDFBuffer({ title, subtitle, sections = [], footer = null }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fillColor('#1e40af').fontSize(22).font('Helvetica-Bold').text('BM Group of Institutions', { align: 'center' });
      doc.moveDown(0.2);
      doc.fillColor('#333').fontSize(16).font('Helvetica-Bold').text(title || 'Report', { align: 'center' });
      if (subtitle) {
        doc.fontSize(11).font('Helvetica').fillColor('#666').text(subtitle, { align: 'center' });
      }
      doc.moveDown(0.5);
      doc.strokeColor('#1e40af').lineWidth(2).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(1);

      // Sections
      sections.forEach(sec => {
        if (sec.heading) {
          doc.fillColor('#1e40af').fontSize(14).font('Helvetica-Bold').text(sec.heading);
          doc.moveDown(0.3);
        }
        if (sec.text) {
          doc.fillColor('#000').fontSize(11).font('Helvetica').text(sec.text, { align: 'left', lineGap: 3 });
          doc.moveDown(0.6);
        }
        if (sec.bullets && Array.isArray(sec.bullets)) {
          sec.bullets.forEach(b => {
            doc.fillColor('#000').fontSize(11).font('Helvetica').text('•  ' + b, { indent: 10, lineGap: 3 });
          });
          doc.moveDown(0.6);
        }
        if (sec.table && Array.isArray(sec.table.rows)) {
          const { headers = [], rows = [] } = sec.table;
          if (headers.length) {
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e40af');
            doc.text(headers.join('   |   '));
            doc.font('Helvetica').fillColor('#000');
            doc.moveDown(0.3);
          }
          rows.forEach(r => {
            doc.fontSize(10).text(r.join('   |   '));
          });
          doc.moveDown(0.6);
        }
      });

      // Footer
      doc.moveDown(1);
      doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#666').text(
        footer || `Generated by BM Bot on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        { align: 'center' }
      );

      doc.end();
    } catch (err) { reject(err); }
  });
}

// ---------- Routes ----------
app.get('/', (req, res) => res.send('BM Group Enterprise ERP Active!'));
app.get('/health', (req, res) => res.json({ status: 'ok', ai: GEMINI_API_KEY ? 'gemini' : 'disabled', model: GEMINI_MODEL, pdf: 'enabled', timestamp: new Date().toISOString() }));
app.get('/api/ai/health', (req, res) => res.json({ aiEnabled: !!GEMINI_API_KEY, model: GEMINI_MODEL, features: ['chat','chat-with-file','predict','admin-insights','generate-report-pdf','generate-notes-pdf','smart-alerts','subject-analysis'] }));

// ========== AUTH ==========
app.post('/api/auth/register', async (req, res) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: parseResult.error.errors[0].message });
    let { name, rollNo, password, deviceId, role, subject } = parseResult.data;
    let cleanRoll = rollNo.trim().toUpperCase();
    if (role === 'student' && !/^24(CSE|AIDS)\d{2}$/.test(cleanRoll)) return res.status(400).json({ error: 'Invalid Roll Number format! Use 24CSE01 or 24AIDS01 format.' });
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
    const newUser = new User({ name, rollNo: cleanRoll, password: hashedPassword, role, boundDeviceId, branch, facultySubject: (role === 'faculty') ? subject : null });
    await newUser.save();
    if (role === 'faculty' && subject) {
      await TeacherSubject.create({ teacherRollNo: cleanRoll, subject: mapToCanonical(subject), assignedBy: cleanRoll });
    }
    res.status(201).json({ message: `${role} ${name} Registered!`, rollNo: cleanRoll });
  } catch (err) { console.error('Registration error:', err); res.status(500).json({ error: err.message }); }
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
    user.failedAttempts = 0; user.blockUntil = null;
    if (user.role === 'student') {
      if (!user.boundDeviceId && deviceId) { user.boundDeviceId = deviceId; await user.save(); }
      else if (user.boundDeviceId && user.boundDeviceId !== deviceId) return res.status(403).json({ error: 'Unauthorized Device! Account bound to another phone.' });
    }
    const token = jwt.sign({ id: user._id, rollNo: user.rollNo, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    user.activeSession = token; await user.save();
    res.json({ message: 'Login successful!', token, user: { name: user.name, rollNo: user.rollNo, role: user.role, branch: user.branch } });
  } catch (err) { console.error('Login error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) { const decoded = jwt.decode(token); if (decoded) await User.findOneAndUpdate({ rollNo: decoded.rollNo }, { activeSession: null }); }
    res.json({ message: 'Logged out successfully!' });
  } catch (err) { console.error('Logout error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/verify-passcode', async (req, res) => {
  try {
    const { passcode, type } = req.body;
    if (!passcode || !type) return res.status(400).json({ error: 'Passcode and type required.' });
    const doc = await Passcode.findOne({ passcode: passcode.trim(), type, expiresAt: { $gt: new Date() } });
    if (doc) res.json({ valid: true, message: 'Passcode valid.' });
    else res.status(400).json({ error: 'Invalid or expired passcode.' });
  } catch (err) { console.error('Verify passcode error:', err); res.status(500).json({ error: err.message }); }
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
    res.json({ message: 'Profile updated!', user: { name: user.name, rollNo: user.rollNo, email: user.email, phone: user.phone, semester: user.semester, branch: user.branch, profilePic: user.profilePic } });
  } catch (err) { console.error('Profile update error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/student/profile/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll }).select('-password -activeSession');
    if (!user) return res.status(404).json({ error: 'User not found!' });
    res.json(user);
  } catch (err) { console.error('Profile fetch error:', err); res.status(500).json({ error: err.message }); }
});

// ========== ADMIN ==========
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
  } catch (err) { console.error('Reset password error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-device', async (req, res) => {
  try {
    const { requesterRollNo, targetRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanRoll = targetRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: `User ${cleanRoll} not found!` });
    user.boundDeviceId = null; await user.save();
    res.json({ message: `✅ Device binding reset for ${cleanRoll}!` });
  } catch (err) { console.error('Reset device error:', err); res.status(500).json({ error: err.message }); }
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
    res.json({ message: `Roll updated from ${cleanOld} to ${cleanNew}!` });
  } catch (err) { console.error('Update roll error:', err); res.status(500).json({ error: err.message }); }
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
    res.json({ message: `Account deleted for ${cleanTarget}!` });
  } catch (err) { console.error('Delete user error:', err); res.status(500).json({ error: err.message }); }
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
  } catch (err) { console.error('Impersonate error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fix-all-attendance-subjects', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const allRecords = await Attendance.find({}).lean();
    if (!allRecords.length) return res.json({ message: 'No records.', fixed: 0, merged: 0, deleted: 0, totalScanned: 0, untouched: 0 });
    let fixedCount = 0, mergedCount = 0, untouchedCount = 0;
    const toDelete = [], toUpdate = [];
    const seenKey = new Map();
    for (const rec of allRecords) {
      const canonical = mapToCanonical(rec.subject);
      const key = `${rec.rollNo}|${rec.date}|${canonical}`;
      if (seenKey.has(key)) { toDelete.push(rec._id); mergedCount++; continue; }
      seenKey.set(key, rec._id);
      if (rec.subject !== canonical) { toUpdate.push({ _id: rec._id, subject: canonical }); fixedCount++; }
      else untouchedCount++;
    }
    for (const u of toUpdate) await Attendance.updateOne({ _id: u._id }, { $set: { subject: u.subject } });
    if (toDelete.length) await Attendance.deleteMany({ _id: { $in: toDelete } });
    res.json({ message: `✅ Fixed ${fixedCount}, merged ${mergedCount}.`, totalScanned: allRecords.length, fixed: fixedCount, merged: mergedCount, untouched: untouchedCount, deleted: toDelete.length });
  } catch (err) { console.error('Fix all error:', err); res.status(500).json({ error: err.message }); }
});

// ========== TEACHER SUBJECTS ==========
app.post('/api/admin/assign-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTeacher = teacherRollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanTeacher, role: 'faculty' });
    if (!teacher) return res.status(404).json({ error: 'Faculty not found!' });
    const canonical = mapToCanonical(subject);
    const existing = await TeacherSubject.findOne({ teacherRollNo: cleanTeacher, subject: canonical });
    if (existing) return res.status(400).json({ error: 'Already assigned.' });
    await TeacherSubject.create({ teacherRollNo: cleanTeacher, subject: canonical, assignedBy: requesterRollNo });
    res.json({ message: `Subject "${subject}" assigned to ${cleanTeacher}` });
  } catch (err) { console.error('Assign subject error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/remove-subject', async (req, res) => {
  try {
    const { requesterRollNo, teacherRollNo, subject } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const cleanTeacher = teacherRollNo.trim().toUpperCase();
    await TeacherSubject.findOneAndDelete({ teacherRollNo: cleanTeacher, subject: mapToCanonical(subject) });
    res.json({ message: `Subject removed from ${cleanTeacher}` });
  } catch (err) { console.error('Remove subject error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/teacher/subjects/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const assignments = await TeacherSubject.find({ teacherRollNo: cleanRoll });
    res.json(assignments.map(a => mapToCanonical(a.subject)));
  } catch (err) { console.error('Get teacher subjects error:', err); res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { console.error('Get teacher students error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/teacher/class-average/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanRoll, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Teacher not found!' });
    const subjects = await TeacherSubject.find({ teacherRollNo: cleanRoll }).distinct('subject');
    if (subjects.length === 0) return res.json({ average: 0 });
    const records = await Attendance.find({ subject: { $in: subjects } });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
    res.json({ average: total > 0 ? Math.round((present / total) * 100) : 0 });
  } catch (err) { console.error('Class average error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/teacher/mark-attendance', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, studentRollNo } = req.body;
    const todayDate = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const teacher = await User.findOne({ rollNo: cleanRoll, role: 'faculty' });
    if (!teacher) return res.status(403).json({ error: 'Only faculty can mark attendance.' });
    const subj = mapToCanonical(subject);
    const assignment = await TeacherSubject.findOne({ teacherRollNo: cleanRoll, subject: subj });
    if (!assignment) return res.status(403).json({ error: `Not authorized for "${subject}".` });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` });
    if (!studentRollNo) return res.status(400).json({ error: 'Student roll number required.' });
    const cleanStudent = studentRollNo.trim().toUpperCase();
    const studentUser = await User.findOne({ rollNo: cleanStudent, role: 'student' });
    if (!studentUser) return res.status(404).json({ error: 'Student not found!' });
    const exists = await Attendance.findOne({ rollNo: cleanStudent, subject: subj, date: todayDate });
    if (exists) return res.status(400).json({ error: `Already marked.` });
    await new Attendance({ rollNo: cleanStudent, studentName: studentUser.name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: studentUser.branch || 'CSE' }).save();
    res.status(201).json({ message: `✅ Marked ${studentUser.name} (${subject})` });
  } catch (err) { console.error('Teacher mark error:', err); res.status(500).json({ error: err.message }); }
});

// ========== PASSCODE ==========
app.post('/api/admin/generate-passcode', async (req, res) => {
  try {
    const { requesterRollNo, type } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'User not found!' });
    if (requester.role === 'admin') { /* allowed */ }
    else if (requester.role === 'faculty' && type === 'single_lecture') { /* allowed */ }
    else return res.status(403).json({ error: 'Access Denied.' });
    if (!type || !['full_day', 'single_lecture'].includes(type)) return res.status(400).json({ error: 'Invalid passcode type.' });
    if (type === 'single_lecture') {
      const branch = requester.branch || 'CSE';
      const period = getCurrentPeriod(branch);
      if (!period) return res.status(400).json({ error: 'No active lecture period right now.' });
      const now = new Date();
      const dateStr = getISTDateString(now);
      const key = `single_lecture_${dateStr}_${period.start}`;
      let doc = await Passcode.findOne({ key, type: 'single_lecture' });
      if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing passcode.', passcode: doc.passcode, type, expiresAt: doc.expiresAt });
      const passcode = Math.floor(1000 + Math.random() * 9000).toString();
      const expiry = new Date(now.getTime() + 5 * 60 * 1000);
      await Passcode.deleteMany({ key, type: 'single_lecture' });
      await new Passcode({ passcode, type, key, expiresAt: expiry }).save();
      await Passcode.deleteMany({ type, expiresAt: { $lt: new Date() } });
      return res.json({ message: 'Passcode generated.', passcode, type, expiresAt: expiry });
    }
    if (type === 'full_day') {
      const now = new Date();
      const dateStr = getISTDateString(now);
      const key = `full_day_${dateStr}`;
      let doc = await Passcode.findOne({ key, type: 'full_day' });
      if (doc && doc.expiresAt > new Date()) return res.json({ message: 'Existing Full Day passcode.', passcode: doc.passcode, type, expiresAt: doc.expiresAt });
      const passcode = Math.floor(10000 + Math.random() * 90000).toString();
      const expiry = new Date(now); expiry.setHours(23, 59, 59, 999);
      await Passcode.deleteMany({ key, type: 'full_day' });
      await new Passcode({ passcode, type, key, expiresAt: expiry }).save();
      await Passcode.deleteMany({ type: 'full_day', expiresAt: { $lt: new Date() } });
      return res.json({ message: 'Full Day passcode generated.', passcode, type, expiresAt: expiry });
    }
    res.status(400).json({ error: 'Invalid type' });
  } catch (err) { console.error('Generate passcode error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/current-passcode/:type/:requesterRollNo', async (req, res) => {
  try {
    const { type, requesterRollNo } = req.params;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'User not found' });
    if (requester.role !== 'admin' && requester.role !== 'faculty') return res.status(403).json({ error: 'Access Denied' });
    if (type !== 'single_lecture') return res.status(400).json({ error: 'Only single_lecture supported' });
    const branch = requester.branch || 'CSE';
    const period = getCurrentPeriod(branch);
    if (!period) return res.json({ passcode: null, message: 'No active lecture period' });
    const dateStr = getISTDateString(new Date());
    const key = `single_lecture_${dateStr}_${period.start}`;
    const doc = await Passcode.findOne({ key, type: 'single_lecture', expiresAt: { $gt: new Date() } });
    if (doc) return res.json({ passcode: doc.passcode, expiresAt: doc.expiresAt });
    return res.json({ passcode: null, message: 'No passcode for current period' });
  } catch (err) { console.error('Get current passcode error:', err); res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE MARK ==========
app.post('/api/attendance/mark-lecture', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude, passcode } = req.body;
    if (!rollNo || !subject || !passcode) return res.status(400).json({ error: 'Missing required fields' });
    const todayDate = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const branch = user.branch || 'CSE';
    const currentPeriod = getCurrentPeriod(branch);
    if (!currentPeriod) return res.status(400).json({ error: 'No active lecture period right now.' });
    const normalizedSubject = mapToCanonical(subject);
    const normalizedCurrent = mapToCanonical(currentPeriod.subject);
    if (normalizedCurrent !== normalizedSubject) return res.status(400).json({ error: 'Subject does not match current lecture.' });
    const key = `single_lecture_${todayDate}_${currentPeriod.start}`;
    const passcodeDoc = await Passcode.findOne({ key, type: 'single_lecture', passcode, expiresAt: { $gt: new Date() } });
    if (!passcodeDoc) return res.status(400).json({ error: 'Invalid or expired passcode.' });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) { await incrementFailedAttempts(cleanRoll); return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` }); }
    try {
      await new Attendance({ rollNo: cleanRoll, studentName: user.name, subject: normalizedSubject, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }).save();
    } catch (err) { if (err.code === 11000) return res.status(400).json({ error: `Already marked.` }); throw err; }
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null;
    await user.save();
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) { console.error('Mark lecture error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/mark-fullday', async (req, res) => {
  try {
    const { rollNo, name, latitude, longitude, passcode } = req.body;
    if (!passcode) return res.status(400).json({ error: 'Full Day passcode required!' });
    const todayDate = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    const passcodeDoc = await Passcode.findOne({ passcode: passcode.trim(), type: 'full_day', expiresAt: { $gt: new Date() } });
    if (!passcodeDoc) return res.status(400).json({ error: 'Invalid or expired Full Day passcode.' });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) { await incrementFailedAttempts(cleanRoll); return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` }); }
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[new Date().getDay()];
    const allSubjects = timetable[dayName] || [];
    const acadSet = new Set();
    allSubjects.forEach(e => { const s = mapToCanonical(e.subject); if (!s.includes("LIB") && !s.includes("Library") && !s.includes("Sports")) acadSet.add(s); });
    const academicSubjects = Array.from(acadSet);
    const existing = await Attendance.find({ rollNo: cleanRoll, date: todayDate, subject: { $in: academicSubjects } });
    const existingSet = new Set(existing.map(r => mapToCanonical(r.subject)));
    let markedCount = 0, skippedCount = 0;
    const newAtt = [];
    for (const sub of academicSubjects) {
      if (!existingSet.has(sub)) { newAtt.push({ rollNo: cleanRoll, studentName: name, subject: sub, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch }); markedCount++; }
      else skippedCount++;
    }
    if (newAtt.length > 0) await Attendance.insertMany(newAtt, { ordered: false }).catch(err => { if (err.code !== 11000) throw err; });
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    user.failedAttempts = 0; user.blockUntil = null;
    await user.save();
    if (markedCount === 0 && skippedCount > 0) return res.status(400).json({ error: `All ${skippedCount} subjects already marked today!` });
    if (markedCount === 0) return res.status(400).json({ error: 'No academic subjects found for today.' });
    res.status(201).json({ message: `✅ Full Day Marked (${markedCount} new, ${skippedCount} already)!` });
  } catch (err) { console.error('Full Day error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { rollNo, name, subject, latitude, longitude } = req.body;
    const todayDate = getISTDateString(new Date());
    const dateStatus = await checkDateStatus(todayDate);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const cleanRoll = rollNo.trim().toUpperCase();
    const blockCheck = await checkStudentBlocked(cleanRoll);
    if (blockCheck.blocked) return res.status(403).json({ error: blockCheck.message });
    const locCheck = checkLocation(latitude, longitude);
    if (!locCheck.isInside) { await incrementFailedAttempts(cleanRoll); return res.status(400).json({ error: `Outside College Boundary! (${locCheck.distance}m away)` }); }
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const subj = mapToCanonical(subject);
    const isLab = subj.includes("LAB") || subj.includes("Lab");
    const todayEntries = await Attendance.find({ rollNo: cleanRoll, subject: subj, date: todayDate });
    if (isLab && todayEntries.length >= 1) return res.status(400).json({ error: `Already marked for ${subject} today!` });
    user.failedAttempts = 0; user.blockUntil = null;
    await new Attendance({ rollNo: cleanRoll, studentName: name, subject: subj, date: todayDate, status: 'Present', location: { latitude, longitude }, ipAddress: req.ip, isVerified: true, branch: user.branch || 'CSE' }).save();
    user.lastAttendanceTime = new Date();
    user.lastAttendanceLocation = { latitude, longitude };
    await user.save();
    res.status(201).json({ message: `✅ Attendance Marked for ${subject}!` });
  } catch (err) { console.error('Attendance mark error:', err); res.status(500).json({ error: err.message }); }
});

// ========== NOTICES ==========
app.get('/api/notices', async (req, res) => {
  try { const notices = await Notice.find().sort({ date: -1 }).limit(10); res.json(notices); }
  catch (err) { console.error('Get notices error:', err); res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/notice', async (req, res) => {
  try {
    const { requesterRollNo, title, message } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!message || message.trim() === "") { await Notice.deleteMany({}); return res.json({ message: 'Notices cleared!' }); }
    const newNotice = await new Notice({ title: title || 'Announcement', message }).save();
    res.status(201).json({ message: 'Notice published!', notice: newNotice });
  } catch (err) { console.error('Post notice error:', err); res.status(500).json({ error: err.message }); }
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
    if (dayName === 'Saturday' || dayName === 'Sunday') return res.status(400).json({ error: 'Cannot declare holiday on weekend!' });
    await Holiday.findOneAndUpdate({ date }, { date, reason: reason || 'College Holiday' }, { upsert: true, new: true });
    res.json({ message: `✅ Holiday declared for ${date}: ${reason}` });
  } catch (err) { console.error('Declare holiday error:', err); res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/holiday/:date', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const result = await Holiday.findOneAndDelete({ date: req.params.date });
    if (!result) return res.status(404).json({ error: 'Holiday not found!' });
    res.json({ message: `Holiday on ${req.params.date} deleted.` });
  } catch (err) { console.error('Delete holiday error:', err); res.status(500).json({ error: err.message }); }
});
app.get('/api/holidays', async (req, res) => {
  try { const holidays = await Holiday.find(); res.json(holidays); }
  catch (err) { console.error('Get holidays error:', err); res.status(500).json({ error: err.message }); }
});
app.get('/api/date-status/:date', async (req, res) => {
  try { const status = await checkDateStatus(req.params.date); res.json(status); }
  catch (err) { console.error('Date status error:', err); res.status(500).json({ error: err.message }); }
});

// ========== DASHBOARD STATS ==========
app.get('/api/admin/dashboard-stats/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const totalStudents = await User.countDocuments({ role: 'student' });
    const todayDate = getISTDateString(new Date());
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
    const totalAttendance = await Attendance.countDocuments();
    const presentCount = await Attendance.countDocuments({ status: 'Present' });
    const overallPct = totalAttendance > 0 ? Math.round((presentCount / totalAttendance) * 100) : 0;
    const workingDaysSoFar = await getWorkingDays(SEMESTER_START, new Date());
    const totalWorkingDaysSemester = await getWorkingDays(SEMESTER_START, SEMESTER_END);
    res.json({ totalStudents, todayPresent, todayAbsent: absentRollNos.length, overallAttendance: totalAttendance, overallPct, todayPresentStudents: presentList, workingDaysSoFar, totalWorkingDaysSemester });
  } catch (err) { console.error('Dashboard stats error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/all-users/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const users = await User.find().select('name rollNo role boundDeviceId email phone semester branch profilePic facultySubject').sort({ rollNo: 1 });
    res.json(users);
  } catch (err) { console.error('Get all users error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/faculty/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const faculty = await User.find({ role: 'faculty' }).select('name rollNo email phone facultySubject').sort({ rollNo: 1 });
    res.json(faculty);
  } catch (err) { console.error('Get faculty error:', err); res.status(500).json({ error: err.message }); }
});

// ========== ATTENDANCE VIEW/DELETE/UPDATE ==========
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
      records = records.filter(r => subjects.includes(mapToCanonical(r.subject)));
    }
    records = records.map(r => { r.subject = mapToCanonical(r.subject); return r; });
    res.json(records);
  } catch (err) { console.error('Get student attendance error:', err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete/:id/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied' });
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      if (!subjects.includes(mapToCanonical(record.subject))) return res.status(403).json({ error: 'Not authorized.' });
    }
    await Attendance.findByIdAndDelete(req.params.id);
    res.json({ message: 'Record deleted!' });
  } catch (err) { console.error('Delete record error:', err); res.status(500).json({ error: err.message }); }
});

app.put('/api/attendance/update/:id', async (req, res) => {
  try {
    const { status, requesterRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied' });
    const record = await Attendance.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      if (!subjects.includes(mapToCanonical(record.subject))) return res.status(403).json({ error: 'Not authorized.' });
    }
    record.status = status;
    await record.save();
    res.json({ message: 'Record updated!' });
  } catch (err) { console.error('Update record error:', err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/attendance/delete-day/:rollNo/:date/:requesterRollNo', async (req, res) => {
  try {
    const { rollNo, date, requesterRollNo } = req.params;
    const cleanRoll = rollNo.trim().toUpperCase();
    const cleanDate = date.trim();
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied' });
    let query = { rollNo: cleanRoll, date: cleanDate };
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      query.subject = { $in: subjects };
    }
    const result = await Attendance.deleteMany(query);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'No records found.' });
    res.json({ message: `Deleted ${result.deletedCount} records.` });
  } catch (err) { console.error('Delete day error:', err); res.status(500).json({ error: err.message }); }
});

// ========== MONTHLY SUMMARY ==========
app.get('/api/student/monthly-summary/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const { month } = req.query;
    if (month === undefined || isNaN(parseInt(month))) return res.status(400).json({ error: 'Month required' });
    const m = parseInt(month);
    if (m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' });
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const startDate = new Date(2026, m, 1);
    const endDate = new Date(2026, m + 1, 0);
    const startStr = getISTDateString(startDate);
    const endStr = getISTDateString(endDate);
    const records = await Attendance.find({ rollNo: cleanRoll, date: { $gte: startStr, $lte: endStr } }).lean();
    const subjectSet = new Set();
    let totalConducted = 0;
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const holidaySet = new Set((await Holiday.find({ date: { $gte: startStr, $lte: endStr } })).map(h => h.date.split('T')[0]));
    let cur = new Date(startDate);
    while (cur <= endDate) {
      const dateStr = getISTDateString(cur);
      const dow = cur.getDay();
      const isWeekend = (dow === 0 || dow === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dow];
        (timetable[dayName] || []).forEach(e => {
          const sub = mapToCanonical(e.subject);
          if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) { subjectSet.add(sub); totalConducted++; }
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    const subjectStats = {};
    subjectSet.forEach(sub => { subjectStats[sub] = { total: 0, present: 0 }; });
    cur = new Date(startDate);
    while (cur <= endDate) {
      const dateStr = getISTDateString(cur);
      const dow = cur.getDay();
      const isWeekend = (dow === 0 || dow === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        const dayName = dayNameMap[dow];
        (timetable[dayName] || []).forEach(e => { const sub = mapToCanonical(e.subject); if (subjectStats[sub]) subjectStats[sub].total++; });
      }
      cur.setDate(cur.getDate() + 1);
    }
    records.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (subjectStats[sub] && (rec.status === 'Present' || rec.status === 'Duty Leave')) subjectStats[sub].present++;
    });
    let totalAttended = 0;
    Object.values(subjectStats).forEach(st => totalAttended += st.present);
    const pct = totalConducted > 0 ? Math.round((totalAttended / totalConducted) * 100) : 0;
    const presentDays = new Set(records.filter(r => r.status === 'Present' || r.status === 'Duty Leave').map(r => r.date));
    const subjectStatsWithPct = {};
    Object.keys(subjectStats).forEach(sub => {
      const st = subjectStats[sub];
      subjectStatsWithPct[sub] = { total: st.total, present: st.present, percentage: st.total > 0 ? Math.round((st.present / st.total) * 100) : 0 };
    });
    res.json({ totalConducted, totalAttended, attendancePercentage: pct, daysPresent: presentDays.size, subjectStats: subjectStatsWithPct });
  } catch (err) { console.error('Monthly summary error:', err); res.status(500).json({ error: err.message }); }
});

// ========== MANUAL ATTENDANCE ==========
app.post('/api/admin/manual-attendance-bulk', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNo, date, subjects, status } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const parts = date.split('-');
    const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    if (dateObj < SEMESTER_START) return res.status(400).json({ error: 'Before semester start!' });
    const dateStatus = await checkDateStatus(date);
    if (dateStatus.isBlocked) return res.status(400).json({ error: dateStatus.message });
    const targetRoll = studentRollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: targetRoll });
    if (!user) return res.status(404).json({ error: `Roll ${targetRoll} not found!` });
    const actualBranch = user.branch || 'CSE';
    let markedCount = 0, markedSubjects = [], alreadyMarked = [];
    const timetable = getTimetableForBranch(actualBranch);
    let subjectsToMark = subjects;
    if (!subjectsToMark || subjectsToMark.length === 0) {
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = days[dateObj.getDay()];
      subjectsToMark = (timetable[dayName] || []).filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports")).map(e => mapToCanonical(e.subject));
    }
    const uniqueSubjects = [...new Set(subjectsToMark.map(s => mapToCanonical(s)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports')))];
    for (let sub of uniqueSubjects) {
      const existing = await Attendance.findOne({ rollNo: targetRoll, subject: sub, date });
      if (existing) { alreadyMarked.push(sub); continue; }
      await new Attendance({ rollNo: targetRoll, studentName: user.name, subject: sub, date, status: status || 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'admin-manual', isVerified: true, branch: actualBranch }).save();
      markedCount++; markedSubjects.push(sub);
    }
    let message = `✅ Marked ${markedCount} lectures for ${user.name} on ${date}`;
    if (alreadyMarked.length > 0) message += `. Already: ${alreadyMarked.join(', ')}`;
    res.status(201).json({ message, markedSubjects, alreadyMarked, total: markedCount });
  } catch (err) { console.error('Manual attendance error:', err); res.status(500).json({ error: err.message }); }
});

// ========== HISTORY ==========
app.get('/api/attendance/history/:rollNo', async (req, res) => {
  try {
    const records = await Attendance.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ date: -1 });
    res.json(records.map(r => { r.subject = mapToCanonical(r.subject); return r; }));
  } catch (err) { console.error('History error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance/all/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    if (!isAdmin && !isTeacher) return res.status(403).json({ error: 'Access Denied' });
    let allRecords;
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      allRecords = await Attendance.find({ subject: { $in: subjects } }).sort({ rollNo: 1, date: -1 });
    } else allRecords = await Attendance.find().sort({ rollNo: 1, date: -1 });
    res.json(allRecords.map(r => { r.subject = mapToCanonical(r.subject); return r; }));
  } catch (err) { console.error('All attendance error:', err); res.status(500).json({ error: err.message }); }
});

// ========== STUDENT SUMMARY ==========
app.get('/api/student/summary/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    const branch = user.branch || 'CSE';
    const timetable = getTimetableForBranch(branch);
    const allRecords = await Attendance.find({ rollNo: cleanRoll }).lean();
    const holidays = await Holiday.find({}).lean();
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
    const today = new Date();
    const semesterStart = new Date('2026-07-15T00:00:00+05:30');
    let current = new Date(semesterStart);
    let totalConductedAcademicSubjects = 0;
    const academicDaysSet = new Set();
    const subjectStats = {};
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayAcademicSubjects = {};
    for (let d = 0; d < 7; d++) {
      const dayName = dayNameMap[d];
      const subjects = timetable[dayName] || [];
      const academic = subjects.filter(e => !e.subject.includes("LIB") && !e.subject.includes("Library") && !e.subject.includes("Sports"));
      dayAcademicSubjects[dayName] = academic.map(e => mapToCanonical(e.subject));
    }
    while (current <= today) {
      const dateStr = getISTDateString(current);
      const dow = current.getDay();
      const isWeekend = (dow === 0 || dow === 6);
      const isHoliday = holidaySet.has(dateStr);
      if (!isWeekend && !isHoliday) {
        academicDaysSet.add(dateStr);
        const dayName = dayNameMap[dow];
        const acad = dayAcademicSubjects[dayName] || [];
        totalConductedAcademicSubjects += acad.length;
        acad.forEach(sub => { if (!subjectStats[sub]) subjectStats[sub] = { total: 0, present: 0 }; subjectStats[sub].total++; });
      }
      current.setDate(current.getDate() + 1);
    }
    const presentDaysSet = new Set();
    const subjectPresentCount = {};
    allRecords.forEach(rec => {
      const sub = mapToCanonical(rec.subject);
      if (sub.includes("LIB") || sub.includes("Library") || sub.includes("Sports")) return;
      if (rec.status === 'Present' || rec.status === 'Duty Leave') {
        if (!subjectPresentCount[sub]) subjectPresentCount[sub] = 0;
        subjectPresentCount[sub]++;
        presentDaysSet.add(rec.date);
      }
    });
    Object.keys(subjectPresentCount).forEach(sub => { if (subjectStats[sub]) subjectStats[sub].present = subjectPresentCount[sub]; });
    let totalAttended = 0;
    Object.values(subjectPresentCount).forEach(v => totalAttended += v);
    const pct = totalConductedAcademicSubjects > 0 ? Math.round((totalAttended / totalConductedAcademicSubjects) * 100) : 0;
    const daysPresent = presentDaysSet.size;
    const totalWorkingDays = academicDaysSet.size;
    const subjectStatsFinal = {};
    for (let [sub, stats] of Object.entries(subjectStats)) {
      subjectStatsFinal[sub] = { present: stats.present || 0, total: stats.total || 0, percentage: stats.total > 0 ? Math.round(((stats.present || 0) / stats.total) * 100) : 0 };
    }
    const workingDaysSoFar = await getWorkingDays(semesterStart, today);
    const totalWorkingDaysSemester = await getWorkingDays(semesterStart, SEMESTER_END);
    res.json({ totalAcademicLectures: totalAttended, totalConductedLectures: totalConductedAcademicSubjects, attendancePercentage: pct, daysPresent, daysAbsent: totalWorkingDays - daysPresent, workingDaysSoFar, totalWorkingDaysSemester, subjectStats: subjectStatsFinal });
  } catch (err) { console.error('Student summary error:', err); res.status(500).json({ error: err.message }); }
});

// ========== EXPORT ==========
app.get('/api/export/google-sheets/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const records = await Attendance.find().sort({ rollNo: 1, date: -1 });
    let csvOut = 'Roll No,Student Name,Subject,Date,Status,IP Address,Location\n';
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csvOut += `${r.rollNo},${r.studentName},${mapToCanonical(r.subject)},${r.date},${r.status},${r.ipAddress || 'N/A'},${loc}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
    res.send(csvOut);
  } catch (err) { console.error('Google sheets export error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/export/student-attendance/:requesterRollNo', async (req, res) => {
  try {
    const requesterRollNo = req.params.requesterRollNo.trim().toUpperCase();
    const requester = await User.findOne({ rollNo: requesterRollNo });
    if (!requester) return res.status(403).json({ error: 'Access Denied' });
    const isAdmin = requester.role === 'admin';
    const isTeacher = requester.role === 'faculty';
    const isStudent = requester.role === 'student';
    if (!isAdmin && !isTeacher && !isStudent) return res.status(403).json({ error: 'Access Denied.' });
    const { studentRollNo, range, month } = req.query;
    if (!studentRollNo) return res.status(400).json({ error: 'studentRollNo required' });
    const cleanStudent = studentRollNo.trim().toUpperCase();
    if (isStudent && requester.rollNo !== cleanStudent) return res.status(403).json({ error: 'Only your own attendance.' });
    const today = new Date();
    let startDate, endDate;
    if (range === 'CURRENT_MONTH') { startDate = new Date(today.getFullYear(), today.getMonth(), 1); endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
    else if (range === 'SELECTED_MONTH') { const m = parseInt(month); if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'Invalid month' }); startDate = new Date(2026, m, 1); endDate = new Date(2026, m + 1, 0); }
    else { startDate = new Date(SEMESTER_START); endDate = new Date(SEMESTER_END); }
    const startStr = getISTDateString(startDate);
    const endStr = getISTDateString(endDate);
    let records = await Attendance.find({ rollNo: cleanStudent, date: { $gte: startStr, $lte: endStr } }).sort({ date: 1 });
    if (isTeacher) {
      const subjects = await TeacherSubject.find({ teacherRollNo: requesterRollNo }).distinct('subject');
      records = records.filter(r => subjects.includes(mapToCanonical(r.subject)));
    }
    if (records.length === 0) return res.status(404).json({ error: 'No records found.' });
    const studentName = records[0].studentName || 'Unknown';
    let csvOut = `Student Attendance Report\nStudent: ${studentName} (${cleanStudent})\nRange: ${startStr} to ${endStr}\nGenerated: ${new Date().toLocaleString()}\n\nDate,Subject,Status,Location,IP Address\n`;
    records.forEach(r => {
      const loc = r.location ? `(${r.location.latitude}, ${r.location.longitude})` : 'N/A';
      csvOut += `${r.date},${mapToCanonical(r.subject)},${r.status},${loc},${r.ipAddress || 'N/A'}\n`;
    });
    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    csvOut += `\nTotal: ${total}, Present: ${present}, %: ${pct}%\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=attendance_${cleanStudent}_${range}.csv`);
    res.send(csvOut);
  } catch (err) { console.error('Student export error:', err); res.status(500).json({ error: err.message }); }
});

// ========== SUBJECTS DROPDOWN ==========
app.get('/api/timetable/subjects', async (req, res) => {
  try {
    const set = new Set();
    const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    allDays.forEach(day => {
      CSE_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject)));
      AIDS_TIME_TABLE[day].forEach(e => set.add(mapToCanonical(e.subject)));
    });
    res.json([...set].sort());
  } catch (err) { console.error('Subjects dropdown error:', err); res.status(500).json({ error: err.message }); }
});

// ========== CLASS REPORT ==========
app.get('/api/admin/class-attendance-report', async (req, res) => {
  try {
    const { requesterRollNo, startDate, endDate, branch } = req.query;
    if (!requesterRollNo) return res.status(400).json({ error: 'requesterRollNo required' });
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
    const end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
    const startStr = getISTDateString(start);
    const endStr = getISTDateString(end);
    let query = { role: 'student' };
    if (branch && branch !== 'ALL' && branch !== 'undefined' && branch !== 'null') query.branch = branch.toUpperCase();
    const students = await User.find(query).select('rollNo name branch');
    if (students.length === 0) return res.json({ students: [], totalLectures: 0 });
    const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
    const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
    const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const resultStudents = await Promise.all(students.map(async (student) => {
      const b = student.branch || 'CSE';
      const tt = getTimetableForBranch(b);
      let totalConducted = 0;
      let cur = new Date(start);
      while (cur <= end) {
        const dateStr = getISTDateString(cur);
        const dow = cur.getDay();
        const isWeekend = (dow === 0 || dow === 6);
        const isHoliday = holidaySet.has(dateStr);
        if (!isWeekend && !isHoliday) {
          const dayName = dayNameMap[dow];
          (tt[dayName] || []).forEach(e => {
            const sub = mapToCanonical(e.subject);
            if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) totalConducted++;
          });
        }
        cur.setDate(cur.getDate() + 1);
      }
      const presentCount = await Attendance.countDocuments({ rollNo: student.rollNo, date: { $gte: startStr, $lte: endStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      return { rollNo: student.rollNo, name: student.name, branch: b, totalPresent: presentCount, totalLectures: totalConducted, percentage: totalConducted > 0 ? Math.round((presentCount / totalConducted) * 100) : 0 };
    }));
    resultStudents.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));
    res.json({ students: resultStudents, totalLectures: resultStudents.length > 0 ? resultStudents[0].totalLectures : 0 });
  } catch (err) { console.error('Class report error:', err); res.status(500).json({ error: err.message }); }
});

// ========== BULK CSE ==========
app.post('/api/admin/bulk-register-and-update-attendance', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const studentData = [
      { rollNo: '24CSE01', name: 'AAKASH RAJ CHAUHAN', present: 35 }, { rollNo: '24CSE03', name: 'ABHISHEK VERMA', present: 0 },
      { rollNo: '24CSE04', name: 'ANKIT KUMAR', present: 0 }, { rollNo: '24CSE06', name: 'ANSHIKA', present: 44 },
      { rollNo: '24CSE08', name: 'ANUJ TIWARI', present: 0 }, { rollNo: '24CSE09', name: 'ASHISH KUMAR', present: 47 },
      { rollNo: '24CSE11', name: 'B DEVIKA', present: 0 }, { rollNo: '24CSE14', name: 'GAUTAM', present: 35 },
      { rollNo: '24CSE15', name: 'HARSH RAJ', present: 11 }, { rollNo: '24CSE16', name: 'HIMANSHI', present: 38 },
      { rollNo: '24CSE18', name: 'HITESH YADAV', present: 0 }, { rollNo: '24CSE19', name: 'ISHANT KUMAR', present: 44 },
      { rollNo: '24CSE20', name: 'JATIN', present: 0 }, { rollNo: '24CSE21', name: 'JATIN YADAV', present: 0 },
      { rollNo: '24CSE22', name: 'JITIN YADAV', present: 0 }, { rollNo: '24CSE23', name: 'KAUSHAL KUMAR', present: 18 },
      { rollNo: '24CSE24', name: 'KRISH BHARDWAJ', present: 1 }, { rollNo: '24CSE25', name: 'MANISH', present: 0 },
      { rollNo: '24CSE27', name: 'MANMOHAN KUMAR', present: 0 }, { rollNo: '24CSE28', name: 'MANOJ', present: 5 },
      { rollNo: '24CSE29', name: 'MAYANK', present: 0 }, { rollNo: '24CSE30', name: 'MD SAMIR ALAM', present: 0 },
      { rollNo: '24CSE31', name: 'MUDIT BEDI', present: 8 }, { rollNo: '24CSE33', name: 'NEHA SHUKLA', present: 39 },
      { rollNo: '24CSE35', name: 'PRASHANT', present: 0 }, { rollNo: '24CSE36', name: 'PREETI', present: 39 },
      { rollNo: '24CSE37', name: 'PURAV RAO', present: 1 }, { rollNo: '24CSE38', name: 'RACHIT SINGH', present: 0 },
      { rollNo: '24CSE39', name: 'RAHUL', present: 0 }, { rollNo: '24CSE40', name: 'RISHAV RAJ', present: 0 },
      { rollNo: '24CSE41', name: 'RITU KUMARI', present: 18 }, { rollNo: '24CSE42', name: 'ROHIT SHRESTA', present: 43 },
      { rollNo: '24CSE43', name: 'RUPESH KUMAR', present: 0 }, { rollNo: '24CSE44', name: 'SAHIL', present: 0 },
      { rollNo: '24CSE45', name: 'SAIESH', present: 0 }, { rollNo: '24CSE46', name: 'SAKSHI KUMARI', present: 21 },
      { rollNo: '24CSE47', name: 'SOURABH RAJPUT', present: 0 }, { rollNo: '24CSE48', name: 'SUMIT SHARMA', present: 12 },
      { rollNo: '24CSE49', name: 'TUSHAR KUMAR', present: 44 }, { rollNo: '24CSE51', name: 'VIDHI BHARGAV', present: 22 },
      { rollNo: '24CSE52', name: 'VINAY', present: 32 }
    ];
    const startDate = new Date('2026-07-15T00:00:00+05:30');
    const endDate = new Date('2026-07-30T23:59:59+05:30');
    const startStr = getISTDateString(startDate);
    const endStr = getISTDateString(endDate);
    let totalRegistered = 0, totalAttendanceAdded = 0;
    for (const item of studentData) {
      const roll = item.rollNo, name = item.name, presentNeeded = item.present;
      let user = await User.findOne({ rollNo: roll });
      if (user) { user.name = name; user.branch = 'CSE'; user.password = await bcrypt.hash('123456', 10); await user.save(); }
      else {
        const newUser = new User({ name, rollNo: roll, password: await bcrypt.hash('123456', 10), role: 'student', branch: 'CSE', boundDeviceId: null });
        await newUser.save(); user = newUser; totalRegistered++;
      }
      await Attendance.deleteMany({ rollNo: roll, date: { $gte: startStr, $lte: endStr } });
      if (presentNeeded === 0) continue;
      let days = [];
      let cur = new Date(startDate);
      while (cur <= endDate) {
        const dateStr = getISTDateString(cur);
        const dow = cur.getDay();
        const isWeekend = (dow === 0 || dow === 6);
        const isHoliday = await Holiday.findOne({ date: dateStr });
        if (!isWeekend && !isHoliday) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
          const tt = getTimetableForBranch('CSE');
          const acad = (tt[dayName] || []).map(s => mapToCanonical(s.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: dateStr, subjects: acad });
        }
        cur.setDate(cur.getDate() + 1);
      }
      let allAvailableSubjects = [];
      for (const d of days) for (const sub of d.subjects) allAvailableSubjects.push({ date: d.date, subject: sub });
      const toMark = Math.min(presentNeeded, allAvailableSubjects.length);
      for (let i = 0; i < toMark; i++) {
        const entry = allAvailableSubjects[i];
        await new Attendance({ rollNo: roll, studentName: name, subject: entry.subject, date: entry.date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-update', isVerified: true, branch: 'CSE' }).save();
        totalAttendanceAdded++;
      }
    }
    res.json({ message: 'CSE Bulk registration completed!', totalRegistered, totalAttendanceAdded });
  } catch (err) { console.error('CSE Bulk error:', err); res.status(500).json({ error: err.message }); }
});

// ========== BULK AIDS ==========
app.post('/api/admin/bulk-register-and-update-attendance-aids', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.body.requesterRollNo?.trim().toUpperCase() || '' });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const studentData = [
      { rollNo: '24AIDS01', name: 'AKASH', present: 1 }, { rollNo: '24AIDS03', name: 'DAVANSH SINGH KARKI', present: 5 },
      { rollNo: '24AIDS04', name: 'FAIZAN AHMAD', present: 40 }, { rollNo: '24AIDS05', name: 'GOPESH JHA', present: 0 },
      { rollNo: '24AIDS06', name: 'HEMANT YADAV', present: 0 }, { rollNo: '24AIDS07', name: 'HUSNAIN AHMAD', present: 40 },
      { rollNo: '24AIDS08', name: 'JANHVI', present: 0 }, { rollNo: '24AIDS09', name: 'JYOTI PUSHPA ROUT', present: 26 },
      { rollNo: '24AIDS11', name: 'MAHIMA', present: 38 }, { rollNo: '24AIDS12', name: 'MOHAMMAD HAMID KHALIL', present: 0 },
      { rollNo: '24AIDS13', name: 'PIYUSH KUMAR', present: 0 }, { rollNo: '24AIDS14', name: 'PRINCE KUMAR', present: 0 },
      { rollNo: '24AIDS16', name: 'SACHIN', present: 0 }, { rollNo: '24AIDS17', name: 'SAHIL PRASAD', present: 5 },
      { rollNo: '24AIDS19', name: 'VINAY', present: 38 }
    ];
    const startDate = new Date('2026-07-15T00:00:00+05:30');
    const endDate = new Date('2026-07-30T23:59:59+05:30');
    const startStr = getISTDateString(startDate);
    const endStr = getISTDateString(endDate);
    let totalRegistered = 0, totalAttendanceAdded = 0;
    for (const item of studentData) {
      const roll = item.rollNo, name = item.name, presentNeeded = item.present;
      let user = await User.findOne({ rollNo: roll });
      if (user) { user.name = name; user.branch = 'AIDS'; user.password = await bcrypt.hash('123456', 10); await user.save(); }
      else {
        const newUser = new User({ name, rollNo: roll, password: await bcrypt.hash('123456', 10), role: 'student', branch: 'AIDS', boundDeviceId: null });
        await newUser.save(); user = newUser; totalRegistered++;
      }
      await Attendance.deleteMany({ rollNo: roll, date: { $gte: startStr, $lte: endStr } });
      if (presentNeeded === 0) continue;
      let days = [];
      let cur = new Date(startDate);
      while (cur <= endDate) {
        const dateStr = getISTDateString(cur);
        const dow = cur.getDay();
        const isWeekend = (dow === 0 || dow === 6);
        const isHoliday = await Holiday.findOne({ date: dateStr });
        if (!isWeekend && !isHoliday) {
          const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
          const tt = getTimetableForBranch('AIDS');
          const acad = (tt[dayName] || []).map(s => mapToCanonical(s.subject)).filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports'));
          days.push({ date: dateStr, subjects: acad });
        }
        cur.setDate(cur.getDate() + 1);
      }
      let allAvailableSubjects = [];
      for (const d of days) for (const sub of d.subjects) allAvailableSubjects.push({ date: d.date, subject: sub });
      const toMark = Math.min(presentNeeded, allAvailableSubjects.length);
      for (let i = 0; i < toMark; i++) {
        const entry = allAvailableSubjects[i];
        await new Attendance({ rollNo: roll, studentName: name, subject: entry.subject, date: entry.date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-update', isVerified: true, branch: 'AIDS' }).save();
        totalAttendanceAdded++;
      }
    }
    res.json({ message: 'AIDS Bulk registration completed!', totalRegistered, totalAttendanceAdded });
  } catch (err) { console.error('AIDS Bulk error:', err); res.status(500).json({ error: err.message }); }
});

// ========== BULK MARK/DELETE ==========
app.post('/api/admin/bulk-mark-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates, subjects } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!studentRollNos || !Array.isArray(studentRollNos) || studentRollNos.length === 0) return res.status(400).json({ error: 'At least one roll no required.' });
    if (!dates || !Array.isArray(dates) || dates.length === 0) return res.status(400).json({ error: 'At least one date required.' });
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Invalid date: ${d}. Use YYYY-MM-DD.` });
    const students = await User.find({ rollNo: { $in: studentRollNos }, role: 'student' });
    if (students.length === 0) return res.status(404).json({ error: 'No valid students.' });
    const results = [];
    let totalMarked = 0, totalSkipped = 0;
    for (const student of students) {
      const branch = student.branch || 'CSE';
      const timetable = getTimetableForBranch(branch);
      let studentMarked = 0, studentSkipped = 0;
      for (const date of dates) {
        const ds = await checkDateStatus(date);
        if (ds.isBlocked) continue;
        const dayName = ds.dayName;
        let daySubjects = timetable[dayName] || [];
        let subjectsToMark = subjects && subjects.length > 0 ? subjects : daySubjects.map(s => mapToCanonical(s.subject));
        const uniqueSubjects = [...new Set(subjectsToMark.filter(s => !s.includes('LIB') && !s.includes('Library') && !s.includes('Sports')))];
        for (const sub of uniqueSubjects) {
          const exists = await Attendance.findOne({ rollNo: student.rollNo, subject: sub, date });
          if (!exists) {
            try {
              await new Attendance({ rollNo: student.rollNo, studentName: student.name, subject: sub, date, status: 'Present', location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG }, ipAddress: 'bulk-mark', isVerified: true, branch }).save();
              studentMarked++;
            } catch (err) { if (err.code === 11000) studentSkipped++; else throw err; }
          } else studentSkipped++;
        }
      }
      results.push({ rollNo: student.rollNo, branch, marked: studentMarked, skipped: studentSkipped });
      totalMarked += studentMarked; totalSkipped += studentSkipped;
    }
    res.json({ message: `✅ Bulk mark: ${totalMarked} new, ${totalSkipped} skipped.`, results });
  } catch (err) { console.error('Bulk mark error:', err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/bulk-delete-attendance', async (req, res) => {
  try {
    const { requesterRollNo, studentRollNos, dates } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    if (!studentRollNos || !Array.isArray(studentRollNos) || studentRollNos.length === 0) return res.status(400).json({ error: 'Roll nos required.' });
    if (!dates || !Array.isArray(dates) || dates.length === 0) return res.status(400).json({ error: 'Dates required.' });
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: `Invalid date: ${d}.` });
    const result = await Attendance.deleteMany({ rollNo: { $in: studentRollNos }, date: { $in: dates } });
    res.json({ message: `✅ Deleted ${result.deletedCount} records.` });
  } catch (err) { console.error('Bulk delete error:', err); res.status(500).json({ error: err.message }); }
});

// ========== CHAT MANAGEMENT ==========
app.get('/api/chats/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const chats = await Chat.find({ rollNo: cleanRoll }).sort({ updatedAt: -1 });
    res.json(chats);
  } catch (err) { console.error('Get chats error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/chats', async (req, res) => {
  try {
    const { rollNo, threadId, title, messages } = req.body;
    const cleanRoll = rollNo.trim().toUpperCase();
    if (!threadId) {
      const newThreadId = `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const newChat = new Chat({ rollNo: cleanRoll, threadId: newThreadId, title: title || 'New Chat', messages: messages || [] });
      await newChat.save();
      return res.status(201).json(newChat);
    } else {
      const chat = await Chat.findOne({ threadId, rollNo: cleanRoll });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      if (title) chat.title = title;
      if (messages) chat.messages = messages;
      chat.updatedAt = new Date();
      await chat.save();
      return res.json(chat);
    }
  } catch (err) { console.error('Create/update chat error:', err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/chats/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const { rollNo } = req.body;
    if (!rollNo) return res.status(400).json({ error: 'rollNo required' });
    const cleanRoll = rollNo.trim().toUpperCase();
    const result = await Chat.findOneAndDelete({ threadId, rollNo: cleanRoll });
    if (!result) return res.status(404).json({ error: 'Chat not found' });
    res.json({ message: 'Chat deleted' });
  } catch (err) { console.error('Delete chat error:', err); res.status(500).json({ error: err.message }); }
});

// ========== LEAVE SYSTEM ==========
app.post('/api/leave/apply', async (req, res) => {
  try {
    const { rollNo, fromDate, toDate, reason, leaveType } = req.body;
    if (!rollNo || !fromDate || !toDate || !reason) return res.status(400).json({ error: 'All fields required.' });
    const cleanRoll = rollNo.trim().toUpperCase();
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });
    if (new Date(toDate) < new Date(fromDate)) return res.status(400).json({ error: 'End date before start date.' });
    const leave = new Leave({ rollNo: cleanRoll, studentName: user.name, fromDate, toDate, reason, leaveType: leaveType || 'Personal', branch: user.branch || 'CSE' });
    await leave.save();
    res.status(201).json({ message: '✅ Leave submitted!', leave });
  } catch (err) { console.error('Leave apply error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/leave/my/:rollNo', async (req, res) => {
  try { res.json(await Leave.find({ rollNo: req.params.rollNo.trim().toUpperCase() }).sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leave/requests/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    res.json(await Leave.find().sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leave/action/:id', async (req, res) => {
  try {
    const { requesterRollNo, action, adminNote } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ error: 'Leave not found!' });
    leave.status = action; leave.reviewedBy = requester.rollNo; leave.adminNote = adminNote || '';
    await leave.save();
    if (action === 'Approved') {
      const student = await User.findOne({ rollNo: leave.rollNo });
      const branch = student?.branch || 'CSE';
      let cur = new Date(leave.fromDate);
      const end = new Date(leave.toDate);
      while (cur <= end) {
        const dateStr = getISTDateString(cur);
        const ds = await checkDateStatus(dateStr);
        if (!ds.isBlocked) {
          const tt = getTimetableForBranch(branch)[ds.dayName] || [];
          for (const entry of tt) {
            const sub = mapToCanonical(entry.subject);
            if (sub.includes('LIB') || sub.includes('Library') || sub.includes('Sports')) continue;
            const exists = await Attendance.findOne({ rollNo: leave.rollNo, subject: sub, date: dateStr });
            if (!exists) await new Attendance({ rollNo: leave.rollNo, studentName: leave.studentName, subject: sub, date: dateStr, status: 'Duty Leave', isVerified: true, branch, ipAddress: 'leave-approved' }).save();
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    }
    res.json({ message: `✅ Leave ${action.toLowerCase()} for ${leave.studentName}` });
  } catch (err) { console.error('Leave action error:', err); res.status(500).json({ error: err.message }); }
});

// ========== TREND ==========
app.get('/api/student/trend/:rollNo', async (req, res) => {
  try {
    const cleanRoll = req.params.rollNo.trim().toUpperCase();
    const months = [6,7,8,9,10,11];
    const labels = ['Jul','Aug','Sep','Oct','Nov','Dec'];
    const data = [];
    for (const m of months) {
      const start = new Date(2026, m, 1);
      const end = new Date(2026, m + 1, 0);
      const startStr = getISTDateString(start);
      const endStr = getISTDateString(end);
      const recs = await Attendance.find({ rollNo: cleanRoll, date: { $gte: startStr, $lte: endStr } });
      const present = recs.filter(r => r.status === 'Present' || r.status === 'Duty Leave').length;
      data.push({ month: labels[m-6], present, total: recs.length });
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== DEFAULTERS ==========
app.get('/api/admin/defaulters/:requesterRollNo', async (req, res) => {
  try {
    const requester = await User.findOne({ rollNo: req.params.requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const threshold = parseInt(req.query.threshold) || 75;
    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const today = getISTDateString(new Date());
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      if (total === 0) { defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: 0, present: 0, total: 0 }); continue; }
      const pct = Math.round((present/total)*100);
      if (pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    res.json({ threshold, defaulters });
  } catch (err) { console.error('Defaulter error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  ROLE-AWARE AI SYSTEM PROMPT BUILDER
// ============================================================
function buildRoleSystemPrompt({ role, userName, contextStr, greeting, emoji }) {
  const baseGreeting = greeting ? `${greeting}, ${userName} ${emoji}!` : '';
  if (role === 'admin') {
    return `You are "BM Bot Admin Assistant" for BM Group of Institutions ERP portal.
${baseGreeting}
You are assisting an ADMIN user with full system access.
Context:
${contextStr}

Your role:
- Provide admin-level insights: statistics, defaulter analysis, class reports, attendance trends.
- Suggest administrative actions (bulk mark, holiday declaration, notice broadcast).
- Help draft notices, warnings, and reports professionally.
- If asked to generate a PDF report, tell user to click the "Download PDF" button or use the "Generate Report" option.
- Be professional, concise, and data-driven. Use emojis sparingly.
- Respond in user's language (Hindi/English).`;
  }
  if (role === 'faculty') {
    return `You are "BM Bot Faculty Assistant" for BM Group of Institutions ERP portal.
${baseGreeting}
You are assisting a FACULTY user.
Context:
${contextStr}

Your role:
- Help faculty view their assigned subjects, student lists, and class averages.
- Help with attendance marking guidance (single-lecture passcode, GPS).
- Suggest teaching material and notes ideas for their subjects.
- If a student asks for notes, generate them clearly with headings and bullet points.
- Be supportive, concise, and educational.
- Respond in user's language (Hindi/English).`;
  }
  // student
  return `You are "BM Bot" for BM Group of Institutions attendance portal.
${baseGreeting}
You are assisting a STUDENT user.
Context:
${contextStr}

Your role:
- Answer questions about attendance, timetable, holidays, working days.
- If user asks "kitne bunk kar sakta hun" or similar, calculate honestly using attendance percentage (75% minimum required) and subject-wise data.
- If user asks for notes, study material, MCQs, summaries — provide clear content with headings, bullet points, examples.
- If user uploads a PDF or image (notes/doubt), read it and explain.
- Warn politely if attendance is below 75%.
- Be friendly, encouraging, use emojis. Respond in user's language (Hindi/English).`;
}

// ============================================================
//  AI: Main Chat (role-aware, multi-turn)
// ============================================================
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, rollNo, role, name, branch, threadId, skipGreeting } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    const cleanRoll = rollNo?.trim().toUpperCase() || 'guest';

    let userData = null, attendanceSummary = null, workingDays = 0, holidays = [], currentPeriod = null;
    let existingChat = null;
    if (cleanRoll !== 'guest' && threadId) {
      try { existingChat = await Chat.findOne({ threadId, rollNo: cleanRoll }); }
      catch (e) { console.warn('Chat history fetch failed:', e.message); }
    }

    if (cleanRoll !== 'guest') {
      try {
        userData = await User.findOne({ rollNo: cleanRoll });
        if (userData) {
          attendanceSummary = await getStudentSummary(userData.rollNo);
          const today = new Date();
          const startStr = getISTDateString(SEMESTER_START);
          const todayStr = getISTDateString(today);
          workingDays = await getWorkingDays(SEMESTER_START, today);
          holidays = await Holiday.find({ date: { $gte: startStr, $lte: todayStr } });
          const branchName = userData.branch || 'CSE';
          currentPeriod = getCurrentPeriod(branchName);
        }
      } catch (err) { console.error('Error fetching user data for chat:', err); }
    }

    // Date/day detection
    let requestedDate = null, requestedDay = null;
    const msgLower = message.toLowerCase();
    if (msgLower.includes('kal') || msgLower.includes('tomorrow')) {
      const d = new Date(); d.setDate(d.getDate() + 1); requestedDate = getISTDateString(d);
    } else if (msgLower.includes('aaj') || msgLower.includes('today')) {
      requestedDate = getISTDateString(new Date());
    } else {
      const dateMatch = message.match(/(\d{1,2})\s+([A-Za-z]+)/) || message.match(/([A-Za-z]+)\s+(\d{1,2})/);
      if (dateMatch) {
        const dayNum = parseInt(dateMatch[1] || dateMatch[2]);
        const monthName = dateMatch[2] || dateMatch[1];
        const monthMap = { 'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5, 'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11 };
        const monthIdx = monthMap[monthName.toLowerCase()];
        if (monthIdx !== undefined && dayNum >= 1 && dayNum <= 31) {
          const d = new Date(2026, monthIdx, dayNum);
          if (!isNaN(d)) requestedDate = getISTDateString(d);
        }
      }
      const dayNames = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      for (const dn of dayNames) { if (msgLower.includes(dn)) { requestedDay = dn.charAt(0).toUpperCase() + dn.slice(1); break; } }
    }

    let requestedTimetable = null, requestedStatus = null;
    if (requestedDate) {
      const status = await checkDateStatus(requestedDate);
      requestedStatus = status;
      if (!status.isBlocked) requestedTimetable = getTimetableForDate(requestedDate, userData?.branch || branch || 'CSE');
    } else if (requestedDay) {
      const tt = getTimetableForBranch(userData?.branch || branch || 'CSE');
      requestedTimetable = tt[requestedDay] || [];
    }

    const now = new Date();
    const hour = now.getHours();
    let greeting = '', emoji = '';
    if (!skipGreeting) {
      if (hour < 12) { greeting = 'Good morning'; emoji = '🌞'; }
      else if (hour < 17) { greeting = 'Good afternoon'; emoji = '🌤️'; }
      else { greeting = 'Good evening'; emoji = '🌙'; }
    }
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';

    let contextStr = `Current date/time: ${now.toLocaleString()}\n`;
    contextStr += `User: ${userName} (Roll: ${cleanRoll}, Role: ${userRole})\n`;
    contextStr += `Branch: ${userData?.branch || branch || 'CSE'}\n`;
    if (attendanceSummary) contextStr += `Attendance summary: ${JSON.stringify(attendanceSummary, null, 2)}\n`;
    contextStr += `Working days so far: ${workingDays}\n`;
    if (holidays.length) contextStr += `Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ')}\n`;
    const todayDay = now.toLocaleString('en', { weekday: 'long' });
    const todayTimetable = getTimetableForBranch(userData?.branch || branch || 'CSE')[todayDay] || [];
    contextStr += `Today's timetable (${todayDay}): ${todayTimetable.map(s => s.subject).join(', ')}\n`;
    if (currentPeriod) contextStr += `Current lecture: ${currentPeriod.subject} (${currentPeriod.start} - ${currentPeriod.end})\n`;
    else contextStr += `Current lecture: No class now\n`;
    if (requestedDate) {
      if (requestedStatus && requestedStatus.isBlocked) contextStr += `Requested date ${requestedDate} is ${requestedStatus.type}: ${requestedStatus.message}\n`;
      else if (requestedTimetable && requestedTimetable.length) contextStr += `Timetable for ${requestedDate}: ${requestedTimetable.map(s => s.subject).join(', ')}\n`;
      else contextStr += `No timetable for ${requestedDate}.\n`;
    } else if (requestedDay) {
      if (requestedTimetable && requestedTimetable.length) contextStr += `Timetable for ${requestedDay}: ${requestedTimetable.map(s => s.subject).join(', ')}\n`;
      else contextStr += `No timetable for ${requestedDay}.\n`;
    }

    const systemPrompt = buildRoleSystemPrompt({ role: userRole, userName, contextStr, greeting, emoji });

    let reply = '', aiError = false;
    if (GEMINI_API_KEY) {
      try {
        reply = await callGemini({
          prompt: message,
          systemPrompt,
          history: existingChat?.messages,
          maxTokens: 1500,
          temperature: 0.7
        });
      } catch (err) { console.warn('⚠️ Gemini exception:', err.message); aiError = true; }
    } else { aiError = true; }

    if (aiError || !reply) {
      let fallback = '';
      if (greeting) fallback = `${greeting}, ${userName} ${emoji}! `;
      if (requestedDate) {
        if (requestedStatus && requestedStatus.isBlocked) fallback += `📅 ${requestedStatus.message}. `;
        else if (requestedTimetable && requestedTimetable.length) fallback += `📖 Timetable for ${requestedDate}: ${requestedTimetable.map(s => s.subject).join(', ')}`;
        else fallback += `No timetable for ${requestedDate}. `;
      } else if (requestedDay) {
        if (requestedTimetable && requestedTimetable.length) fallback += `📖 Timetable for ${requestedDay}: ${requestedTimetable.map(s => s.subject).join(', ')}`;
        else fallback += `No timetable for ${requestedDay}. `;
      } else {
        if (attendanceSummary) fallback += `Your attendance is ${attendanceSummary.attendancePercentage}% (${attendanceSummary.totalAcademicLectures}/${attendanceSummary.totalConductedLectures}). `;
        if (workingDays > 0) fallback += `Working days so far: ${workingDays}. `;
        if (holidays.length > 0) fallback += `Holidays: ${holidays.map(h => `${h.date} (${h.reason})`).join(', ')}. `;
        fallback += `How can I assist you today?`;
      }
      reply = fallback;
    }

    let newThreadId = threadId, newTitle = 'New Chat';
    if (cleanRoll !== 'guest') {
      if (existingChat) {
        existingChat.messages.push({ role: 'user', content: message });
        existingChat.messages.push({ role: 'assistant', content: reply });
        existingChat.updatedAt = new Date();
        if (!existingChat.title || existingChat.title === 'New Chat') existingChat.title = message.substring(0, 50);
        await existingChat.save();
        newThreadId = existingChat.threadId; newTitle = existingChat.title;
      } else {
        const autoTitle = message.substring(0, 50) || 'New Chat';
        const newThread = new Chat({ rollNo: cleanRoll, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, title: autoTitle, messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply }] });
        await newThread.save();
        newThreadId = newThread.threadId; newTitle = autoTitle;
      }
    }
    res.json({ reply, threadId: newThreadId || null, title: newTitle, messages: [] });
  } catch (err) { console.error('❌ Chat error:', err); res.status(500).json({ error: 'Internal error: ' + err.message }); }
});

// ============================================================
//  AI: Chat with FILE (PDF / Image) - multimodal read
// ============================================================
app.post('/api/ai/chat-with-file', async (req, res) => {
  try {
    const { prompt, fileBase64, mimeType, rollNo, role, name, branch, threadId } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64 and mimeType required.' });
    const userPrompt = prompt || 'Explain this document/file. Give me a clear summary with key points.';

    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'text/plain'];
    if (!allowedTypes.some(t => mimeType.includes(t.split('/')[1]) || mimeType === t)) {
      return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Allowed: PDF, PNG, JPG, WEBP, TXT.` });
    }

    const cleanRoll = rollNo?.trim().toUpperCase() || 'guest';
    let userData = null, attendanceSummary = null;
    if (cleanRoll !== 'guest') {
      userData = await User.findOne({ rollNo: cleanRoll });
      if (userData) attendanceSummary = await getStudentSummary(userData.rollNo);
    }
    const userName = userData?.name || name || 'Guest';
    const userRole = userData?.role || role || 'student';

    let contextStr = `User: ${userName} (Roll: ${cleanRoll}, Role: ${userRole})\n`;
    contextStr += `Branch: ${userData?.branch || branch || 'CSE'}\n`;
    if (attendanceSummary) contextStr += `Attendance: ${attendanceSummary.attendancePercentage}% (${attendanceSummary.totalAcademicLectures}/${attendanceSummary.totalConductedLectures})\n`;

    const fileLabels = { pdf: 'PDF document', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', plain: 'text file' };
    const fileTypeLabel = fileLabels[mimeType.split('/')[1]] || 'file';

    const systemPrompt = `You are "BM Bot" for BM Group of Institutions ERP portal.
You are helping ${userName} (${userRole}) with a ${fileTypeLabel} they uploaded.
Context:
${contextStr}

Your task:
- Carefully read and analyze the uploaded ${fileTypeLabel}.
- Answer the user's question based ONLY on content in the file (if the file is about notes, study material, or document — extract, summarize, and explain).
- If the file is an image of notes/handwritten text — transcribe relevant parts.
- If the file is a PDF of a book/chapter — provide a clear summary, key points, important topics.
- If the file is unrelated to studies, still help politely.
- Use markdown formatting: headings, bullet points, bold for important terms.
- If user asked for notes/MCQ/summary — deliver structured content.
- Respond in user's language (Hindi/English).
- Be helpful, concise, well-organized.`;

    let reply = '';
    try {
      reply = await callGemini({
        prompt: userPrompt,
        systemPrompt,
        fileBase64,
        mimeType,
        maxTokens: 3000,
        temperature: 0.4,
        timeoutMs: 90000
      });
    } catch (err) {
      console.warn('⚠️ Gemini file error:', err.message);
      return res.status(500).json({ error: 'AI could not process this file: ' + err.message });
    }

    // Save to chat
    let newThreadId = threadId, newTitle = 'File Analysis';
    if (cleanRoll !== 'guest') {
      const existingChat = threadId ? await Chat.findOne({ threadId, rollNo: cleanRoll }) : null;
      if (existingChat) {
        existingChat.messages.push({ role: 'user', content: `[Uploaded ${fileTypeLabel}] ${userPrompt}` });
        existingChat.messages.push({ role: 'assistant', content: reply });
        existingChat.updatedAt = new Date();
        await existingChat.save();
        newThreadId = existingChat.threadId; newTitle = existingChat.title;
      } else {
        const autoTitle = `File: ${userPrompt.substring(0, 40)}`;
        const newThread = new Chat({
          rollNo: cleanRoll, threadId: `chat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          title: autoTitle,
          messages: [{ role: 'user', content: `[Uploaded ${fileTypeLabel}] ${userPrompt}` }, { role: 'assistant', content: reply }]
        });
        await newThread.save();
        newThreadId = newThread.threadId; newTitle = autoTitle;
      }
    }

    res.json({ reply, threadId: newThreadId, title: newTitle, fileType: fileTypeLabel });
  } catch (err) { console.error('❌ Chat-with-file error:', err); res.status(500).json({ error: 'Internal error: ' + err.message }); }
});

// ============================================================
//  AI: Generate PDF Report (role-based)
// ============================================================
app.post('/api/ai/generate-report-pdf', async (req, res) => {
  try {
    const { rollNo, reportType = 'student-attendance', targetRollNo, startDate, endDate, branch } = req.body;
    const cleanRoll = rollNo?.trim().toUpperCase();
    if (!cleanRoll) return res.status(400).json({ error: 'rollNo required' });

    const requester = await User.findOne({ rollNo: cleanRoll });
    if (!requester) return res.status(404).json({ error: 'User not found' });

    // Role-based access
    if (reportType === 'admin-defaulters' && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can generate defaulter report.' });
    }
    if (reportType === 'class-report' && requester.role !== 'admin') {
      return res.status(403).json({ error: 'Only admin can generate class report.' });
    }

    let pdfBuffer;

    // -------- STUDENT ATTENDANCE REPORT --------
    if (reportType === 'student-attendance') {
      const target = targetRollNo ? targetRollNo.trim().toUpperCase() : cleanRoll;
      if (requester.role === 'student' && target !== cleanRoll) return res.status(403).json({ error: 'Can only export own report.' });
      const targetUser = await User.findOne({ rollNo: target });
      if (!targetUser) return res.status(404).json({ error: 'Target student not found' });

      const summary = await getStudentSummary(target);
      if (!summary) return res.status(500).json({ error: 'Could not generate summary' });

      const recordStart = startDate || getISTDateString(SEMESTER_START);
      const recordEnd = endDate || getISTDateString(new Date());
      const records = await Attendance.find({ rollNo: target, date: { $gte: recordStart, $lte: recordEnd } }).sort({ date: 1 }).lean();

      const subjectRows = Object.entries(summary.subjectStats).map(([sub, st]) => [`${sub}`, `${st.present}/${st.total}`, `${st.percentage}%`]);

      const sections = [
        { heading: '📊 Overview', bullets: [
          `Overall Attendance: ${summary.attendancePercentage}%`,
          `Lectures Attended: ${summary.totalAcademicLectures} / ${summary.totalConductedLectures}`,
          `Days Present: ${summary.daysPresent}`,
          `Working Days So Far: ${summary.workingDaysSoFar} / ${summary.totalWorkingDaysSemester}`,
          `Status: ${summary.attendancePercentage >= 75 ? '✅ Safe Zone' : '⚠️ Below 75% — Risk of Detention'}`
        ]},
        { heading: '📚 Subject-wise Attendance', table: { headers: ['Subject', 'Present/Total', 'Percentage'], rows: subjectRows } },
        { heading: '📅 Recent Records (Last 30)', table: {
          headers: ['Date', 'Subject', 'Status'],
          rows: records.slice(-30).reverse().map(r => [r.date, mapToCanonical(r.subject), r.status])
        }}
      ];

      pdfBuffer = await generatePDFBuffer({
        title: 'Student Attendance Report',
        subtitle: `${targetUser.name} (${target}) • ${targetUser.branch || 'CSE'} • ${recordStart} to ${recordEnd}`,
        sections,
        footer: `Generated by BM Bot on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${target}_${recordStart}.pdf`);
      return res.send(pdfBuffer);
    }

    // -------- ADMIN DEFAULTERS --------
    if (reportType === 'admin-defaulters') {
      const threshold = parseInt(req.body.threshold) || 75;
      const students = await User.find({ role: 'student' }).select('rollNo name branch');
      const today = getISTDateString(new Date());
      const startStr = getISTDateString(SEMESTER_START);
      const defaulters = [];
      for (const s of students) {
        const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        if (total === 0) { defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct: 0, present: 0, total: 0 }); continue; }
        const pct = Math.round((present/total)*100);
        if (pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
      }
      defaulters.sort((a,b) => a.pct - b.pct);

      const rows = defaulters.map(d => [d.rollNo, d.name, d.branch, `${d.present}/${d.total}`, `${d.pct}%`]);

      const sections = [
        { heading: `⚠️ Defaulters Below ${threshold}%`, text: `Total defaulters: ${defaulters.length} out of ${students.length} students.` },
        { heading: '📋 Defaulter List', table: { headers: ['Roll No', 'Name', 'Branch', 'Present/Total', 'Percent'], rows } }
      ];

      pdfBuffer = await generatePDFBuffer({
        title: 'Defaulter Watchlist Report',
        subtitle: `Threshold: ${threshold}% • Branch: ${branch || 'ALL'} • Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        sections
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=defaulters_${threshold}pct.pdf`);
      return res.send(pdfBuffer);
    }

    // -------- CLASS REPORT --------
    if (reportType === 'class-report') {
      const start = startDate ? new Date(startDate) : new Date(SEMESTER_START);
      const end = endDate ? new Date(endDate) : new Date(SEMESTER_END);
      const startStr = getISTDateString(start);
      const endStr = getISTDateString(end);

      let query = { role: 'student' };
      if (branch && branch !== 'ALL' && branch !== 'undefined') query.branch = branch.toUpperCase();
      const students = await User.find(query).select('rollNo name branch');
      const holidays = await Holiday.find({ date: { $gte: startStr, $lte: endStr } });
      const holidaySet = new Set(holidays.map(h => h.date.split('T')[0]));
      const dayNameMap = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

      const resultStudents = [];
      for (const student of students) {
        const b = student.branch || 'CSE';
        const tt = getTimetableForBranch(b);
        let totalConducted = 0;
        let cur = new Date(start);
        while (cur <= end) {
          const dateStr = getISTDateString(cur);
          const dow = cur.getDay();
          const isWeekend = (dow === 0 || dow === 6);
          const isHoliday = holidaySet.has(dateStr);
          if (!isWeekend && !isHoliday) {
            const dayName = dayNameMap[dow];
            (tt[dayName] || []).forEach(e => {
              const sub = mapToCanonical(e.subject);
              if (!sub.includes('Sports') && !sub.includes('LIB') && !sub.includes('Library')) totalConducted++;
            });
          }
          cur.setDate(cur.getDate() + 1);
        }
        const presentCount = await Attendance.countDocuments({ rollNo: student.rollNo, date: { $gte: startStr, $lte: endStr }, status: { $in: ['Present', 'Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
        resultStudents.push({ rollNo: student.rollNo, name: student.name, branch: b, totalPresent: presentCount, totalLectures: totalConducted, percentage: totalConducted > 0 ? Math.round((presentCount / totalConducted) * 100) : 0 });
      }
      resultStudents.sort((a, b) => a.rollNo.localeCompare(b.rollNo, undefined, { numeric: true }));

      const rows = resultStudents.map(s => [s.rollNo, s.name, s.branch, `${s.totalPresent}/${s.totalLectures}`, `${s.percentage}%`]);

      const sections = [
        { heading: '📊 Summary', bullets: [
          `Branch: ${branch || 'ALL'}`,
          `Period: ${startStr} to ${endStr}`,
          `Total Students: ${resultStudents.length}`,
          `Average Attendance: ${resultStudents.length > 0 ? Math.round(resultStudents.reduce((a, s) => a + s.percentage, 0) / resultStudents.length) : 0}%`
        ]},
        { heading: '📋 Student-wise Report', table: { headers: ['Roll No', 'Name', 'Branch', 'Present/Total', 'Percent'], rows } }
      ];

      pdfBuffer = await generatePDFBuffer({
        title: 'Class Attendance Report',
        subtitle: `Branch: ${branch || 'ALL'} • ${startStr} to ${endStr}`,
        sections
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=class_report_${branch || 'ALL'}_${startStr}.pdf`);
      return res.send(pdfBuffer);
    }

    res.status(400).json({ error: 'Unknown reportType. Use: student-attendance, admin-defaulters, class-report' });
  } catch (err) { console.error('❌ PDF report error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Generate Study Notes → PDF
// ============================================================
app.post('/api/ai/generate-notes-pdf', async (req, res) => {
  try {
    const { topic, subject, rollNo, level = 'B.Tech 5th Semester', includeMCQ = false, includeExamples = true } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const cleanRoll = rollNo?.trim().toUpperCase();
    let userName = 'Student';
    if (cleanRoll) {
      const u = await User.findOne({ rollNo: cleanRoll });
      if (u) userName = u.name;
    }

    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'AI not configured.' });

    const prompt = `Generate comprehensive study notes on the topic "${topic}"${subject ? ` (Subject: ${subject})` : ''} for ${level} level students.
Requirements:
- Start with a short Introduction (2-3 lines)
- Main content with clear sub-headings and bullet points
- Include key definitions, important concepts, formulas (if any)
${includeExamples ? '- Include 2-3 real-world examples or use cases' : ''}
${includeMCQ ? '- Include 5 MCQs with 4 options each and mark the correct answer' : ''}
- End with a "Quick Revision" summary of 5-6 bullet points

Format as clean text with markdown-style structure using ## for headings and • for bullets. Do NOT use ** ** (asterisks) for bold since this will be converted to PDF. Use plain text.

Topic: ${topic}`;

    const notesText = await callGemini({
      prompt,
      systemPrompt: 'You are an expert teacher creating structured study notes. Output clean text with headings (use ## prefix), bullets (use • prefix), and numbered lists. Avoid markdown asterisks and special formatting symbols.',
      maxTokens: 3500,
      temperature: 0.5,
      timeoutMs: 90000
    });

    // Convert notes text to sections
    const lines = notesText.split('\n');
    const sections = [];
    let currentSection = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('## ')) {
        if (currentSection) sections.push(currentSection);
        currentSection = { heading: trimmed.replace(/^#+\s*/, ''), bullets: [] };
      } else if (trimmed.startsWith('# ')) {
        if (currentSection) sections.push(currentSection);
        currentSection = { heading: trimmed.replace(/^#+\s*/, ''), bullets: [] };
      } else if (trimmed.startsWith('• ') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (!currentSection) currentSection = { heading: 'Notes', bullets: [] };
        currentSection.bullets.push(trimmed.replace(/^[•\-*]\s*/, ''));
      } else if (/^\d+\.\s/.test(trimmed)) {
        if (!currentSection) currentSection = { heading: 'Notes', bullets: [] };
        currentSection.bullets.push(trimmed);
      } else {
        if (!currentSection) currentSection = { heading: 'Introduction', text: trimmed };
        else if (currentSection.bullets && currentSection.bullets.length === 0 && !currentSection.text) currentSection.text = trimmed;
        else {
          if (!currentSection.bullets) currentSection.bullets = [];
          currentSection.bullets.push(trimmed);
        }
      }
    }
    if (currentSection) sections.push(currentSection);

    const pdfBuffer = await generatePDFBuffer({
      title: 'Study Notes',
      subtitle: `${topic}${subject ? ` • ${subject}` : ''} • For ${userName}`,
      sections,
      footer: `Generated by BM Bot • ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=notes_${topic.replace(/\s+/g, '_').substring(0, 30)}.pdf`);
    res.send(pdfBuffer);
  } catch (err) { console.error('❌ Notes PDF error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Predict Attendance (bunk calculator)
// ============================================================
app.post('/api/ai/predict-attendance', async (req, res) => {
  try {
    const { rollNo, targetPercentage = 75, plannedBunks = 0, plannedAttends = 0 } = req.body;
    const cleanRoll = rollNo?.trim().toUpperCase();
    if (!cleanRoll) return res.status(400).json({ error: 'rollNo required' });
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    const summary = await getStudentSummary(cleanRoll);
    if (!summary) return res.status(500).json({ error: 'Could not compute summary' });

    const attended = summary.totalAcademicLectures;
    const conducted = summary.totalConductedLectures;
    const currentPct = summary.attendancePercentage;
    const target = parseFloat(targetPercentage);

    // Math: (attended + x) / (conducted + x + y) >= target/100
    // where x = future attends, y = future bunks
    // Simplify for plannedAttends=0 and y bunks: attended / (conducted + y) >= target/100
    // y <= (attended * 100 / target) - conducted

    const maxBunks = Math.floor((attended * 100 / target) - conducted);
    const requiredAttends = currentPct >= target ? 0 : Math.ceil(((target / 100) * conducted - attended) / (1 - target / 100));

    // Simulate planned scenarios
    let simulatedPct = currentPct;
    let simulatedAttended = attended;
    let simulatedConducted = conducted;
    if (plannedAttends > 0) { simulatedAttended += plannedAttends; simulatedConducted += plannedAttends; }
    if (plannedBunks > 0) { simulatedConducted += plannedBunks; }
    simulatedPct = simulatedConducted > 0 ? Math.round((simulatedAttended / simulatedConducted) * 100) : 0;

    // AI-enhanced message
    let aiMessage = '';
    if (GEMINI_API_KEY) {
      try {
        const prompt = `A student named ${user.name} (${cleanRoll}) currently has ${currentPct}% attendance (${attended}/${conducted} lectures). Minimum required is ${target}%.
Give a short, encouraging response (2-3 lines, Hinglish) explaining:
- Current situation
- How many lectures they can safely bunk (${maxBunks} lectures) OR how many they need to attend consecutively (${requiredAttends}) to reach ${target}%
- A motivational tip.
No markdown asterisks. Keep it friendly and short.`;

        aiMessage = await callGemini({
          prompt,
          systemPrompt: 'You are BM Bot, a friendly student assistant for BM Group of Institutions. Respond in Hinglish (Hindi + English mix), keep it short and encouraging.',
          maxTokens: 300,
          temperature: 0.7,
          timeoutMs: 30000
        });
      } catch (err) { console.warn('AI msg failed:', err.message); }
    }

    if (!aiMessage) {
      aiMessage = currentPct >= target
        ? `Bhai, tu safe hai! Abhi tu ${maxBunks} lectures bunk kar sakta hai ${target}% pe rehne ke liye. Keep it up! 💪`
        : `Bhai, tu ${target}% se neeche hai. Next ${requiredAttends} lectures consecutively attend kar, phir safe zone me aa jayega. 📚`;
    }

    res.json({
      currentPercentage: currentPct,
      attended, conducted,
      targetPercentage: target,
      maxBunksAllowed: maxBunks > 0 ? maxBunks : 0,
      requiredConsecutiveAttends: requiredAttends,
      simulated: { plannedAttends, plannedBunks, resultingPercentage: simulatedPct },
      aiMessage
    });
  } catch (err) { console.error('❌ Predict error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Admin Insights
// ============================================================
app.post('/api/ai/admin-insights', async (req, res) => {
  try {
    const { requesterRollNo } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });

    const totalStudents = await User.countDocuments({ role: 'student' });
    const totalFaculty = await User.countDocuments({ role: 'faculty' });
    const totalAttendance = await Attendance.countDocuments();
    const totalPresent = await Attendance.countDocuments({ status: 'Present' });
    const overallPct = totalAttendance > 0 ? Math.round((totalPresent / totalAttendance) * 100) : 0;

    const today = getISTDateString(new Date());
    const todayPresent = await Attendance.distinct('rollNo', { date: today, status: 'Present' });

    // Top defaulters
    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const pct = total > 0 ? Math.round((present/total)*100) : 0;
      if (pct < 75) defaulters.push({ rollNo: s.rollNo, name: s.name, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);

    // Subject-wise overall
    const subjectAgg = await Attendance.aggregate([
      { $match: { subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } } },
      { $group: { _id: '$subject', total: { $sum: 1 }, present: { $sum: { $cond: [{ $in: ['$status', ['Present', 'Duty Leave']] }, 1, 0] } } } },
      { $sort: { present: 1 } }
    ]);

    const contextStr = `Admin Dashboard Data:
- Total students: ${totalStudents}
- Total faculty: ${totalFaculty}
- Total attendance records: ${totalAttendance}
- Overall attendance %: ${overallPct}%
- Today's present students: ${todayPresent.length}
- Defaulters (<75%): ${defaulters.length}
- Top 10 defaulters: ${defaulters.slice(0, 10).map(d => `${d.rollNo}(${d.name}): ${d.pct}%`).join(', ')}
- Subject-wise (lowest 5): ${subjectAgg.slice(0, 5).map(s => `${mapToCanonical(s._id)}: ${Math.round((s.present/s.total)*100)}%`).join(', ')}
`;

    let insights = '';
    if (GEMINI_API_KEY) {
      try {
        insights = await callGemini({
          prompt: `Based on the admin dashboard data below, provide a concise, actionable analysis for the admin. Structure it with:
1. Overview (2 lines)
2. Key Concerns (top 3)
3. Recommended Actions (3-4 bullet points)
4. Positive Highlights (if any)
Use plain text with ## headings and • bullets. Avoid ** ** markdown.

${contextStr}`,
          systemPrompt: 'You are BM Bot Admin Assistant. Provide data-driven, professional insights for the college admin. Keep it concise and actionable.',
          maxTokens: 1200,
          temperature: 0.5,
          timeoutMs: 60000
        });
      } catch (err) { console.warn('AI insights failed:', err.message); }
    }

    if (!insights) {
      insights = `## Overview\nTotal ${totalStudents} students, ${overallPct}% overall attendance. ${defaulters.length} defaulters below 75%.\n\n## Key Concerns\n• ${defaulters.length} students below 75%\n• Today only ${todayPresent.length}/${totalStudents} students marked present\n\n## Recommended Actions\n• Send warning notices to defaulters\n• Review subject-wise low attendance\n• Encourage attendance via passcode reminders`;
    }

    res.json({
      stats: { totalStudents, totalFaculty, totalAttendance, overallPct, todayPresentCount: todayPresent.length, defaulterCount: defaulters.length },
      topDefaulters: defaulters.slice(0, 10),
      subjectAggregate: subjectAgg.map(s => ({ subject: mapToCanonical(s._id), total: s.total, present: s.present, pct: Math.round((s.present/s.total)*100) })),
      insights
    });
  } catch (err) { console.error('❌ Admin insights error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Subject-wise Analysis
// ============================================================
app.post('/api/ai/subject-analysis', async (req, res) => {
  try {
    const { rollNo } = req.body;
    const cleanRoll = rollNo?.trim().toUpperCase();
    if (!cleanRoll) return res.status(400).json({ error: 'rollNo required' });
    const user = await User.findOne({ rollNo: cleanRoll });
    if (!user) return res.status(404).json({ error: 'Student not found!' });

    const summary = await getStudentSummary(cleanRoll);
    if (!summary) return res.status(500).json({ error: 'Could not compute summary' });

    const subjects = Object.entries(summary.subjectStats || {}).map(([sub, st]) => ({ subject: sub, ...st }));
    subjects.sort((a, b) => a.percentage - b.percentage);

    const weak = subjects.filter(s => s.percentage < 75);
    const strong = subjects.filter(s => s.percentage >= 75);

    let aiAnalysis = '';
    if (GEMINI_API_KEY && subjects.length > 0) {
      try {
        const prompt = `Student ${user.name} (${cleanRoll}) subject-wise attendance:
${subjects.map(s => `• ${s.subject}: ${s.present}/${s.total} (${s.percentage}%)`).join('\n')}

Provide:
1. Weak subjects (below 75%) with specific advice for each
2. Strong subjects — positive reinforcement
3. Overall strategy (2-3 bullet points) to improve weak subjects

Use plain text, ## headings, • bullets. No ** ** markdown. Keep it encouraging and personalized.`;

        aiAnalysis = await callGemini({
          prompt,
          systemPrompt: 'You are BM Bot, a friendly student mentor for BM Group of Institutions. Give personalized, actionable advice in Hinglish. Use plain text formatting.',
          maxTokens: 1000,
          temperature: 0.6,
          timeoutMs: 60000
        });
      } catch (err) { console.warn('AI subject analysis failed:', err.message); }
    }

    if (!aiAnalysis) {
      aiAnalysis = `## Overall\nAttendance: ${summary.attendancePercentage}%\n\n## Weak Subjects (<75%)\n${weak.length > 0 ? weak.map(s => `• ${s.subject}: ${s.percentage}% — Attend regularly!`).join('\n') : '• None, great job!'}\n\n## Strong Subjects (>=75%)\n${strong.map(s => `• ${s.subject}: ${s.percentage}%`).join('\n')}`;
    }

    res.json({
      overall: summary.attendancePercentage,
      subjects,
      weakSubjects: weak,
      strongSubjects: strong,
      analysis: aiAnalysis
    });
  } catch (err) { console.error('❌ Subject analysis error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Smart Alerts for Defaulters (admin-only)
// ============================================================
app.post('/api/ai/smart-alerts', async (req, res) => {
  try {
    const { requesterRollNo, threshold = 75, limit = 20 } = req.body;
    const requester = await User.findOne({ rollNo: requesterRollNo?.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });

    const students = await User.find({ role: 'student' }).select('rollNo name branch');
    const today = getISTDateString(new Date());
    const startStr = getISTDateString(SEMESTER_START);
    const defaulters = [];
    for (const s of students) {
      const present = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, status: { $in: ['Present','Duty Leave'] }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const total = await Attendance.countDocuments({ rollNo: s.rollNo, date: { $gte: startStr, $lte: today }, subject: { $nin: [/Sports/i, /LIB/i, /Library/i] } });
      const pct = total > 0 ? Math.round((present/total)*100) : 0;
      if (pct < threshold) defaulters.push({ rollNo: s.rollNo, name: s.name, branch: s.branch, pct, present, total });
    }
    defaulters.sort((a,b) => a.pct - b.pct);
    const top = defaulters.slice(0, limit);

    const alerts = [];
    for (const d of top) {
      let message = '';
      if (GEMINI_API_KEY) {
        try {
          message = await callGemini({
            prompt: `Write a short, polite warning message (2-3 lines, Hinglish) for parent/student:
Student: ${d.name} (${d.rollNo}, ${d.branch})
Attendance: ${d.pct}% (${d.present}/${d.total})
Required: ${threshold}%
Need to attend more lectures. Be encouraging but firm. No markdown asterisks.`,
            systemPrompt: 'You are BM Bot writing official warning notices for BM Group of Institutions. Tone: polite, professional yet friendly.',
            maxTokens: 200,
            temperature: 0.6,
            timeoutMs: 20000
          });
        } catch (err) { message = ''; }
      }
      if (!message) message = `Dear ${d.name}, your attendance is ${d.pct}% which is below the required ${threshold}%. Please attend classes regularly to avoid detention. - BM Group`;
      alerts.push({ ...d, message });
    }

    res.json({ threshold, totalDefaulters: defaulters.length, alertsSent: alerts.length, alerts });
  } catch (err) { console.error('❌ Smart alerts error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  AI: Study Material text (no PDF)
// ============================================================
app.post('/api/ai/study-material', async (req, res) => {
  try {
    const { topic, subject, type = 'notes' } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    if (!GEMINI_API_KEY) return res.status(503).json({ error: 'AI not configured.' });

    const typeMap = {
      notes: 'detailed study notes with headings and bullets',
      mcq: '10 multiple choice questions (4 options each, mark correct answer)',
      summary: 'concise summary with key points',
      important: 'important topics and questions for exam',
      examples: 'real-world examples and applications'
    };
    const styleGuide = typeMap[type] || typeMap.notes;

    const reply = await callGemini({
      prompt: `Generate ${styleGuide} on the topic: "${topic}"${subject ? ` (Subject: ${subject})` : ''}.\nUse plain text with ## for headings, • for bullets. No ** ** markdown.`,
      systemPrompt: 'You are an expert teacher for B.Tech students at BM Group of Institutions. Provide clear, well-structured study material.',
      maxTokens: 2500,
      temperature: 0.5,
      timeoutMs: 60000
    });

    res.json({ topic, subject, type, content: reply });
  } catch (err) { console.error('❌ Study material error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  RESTORE FROM CSV
// ============================================================
app.post('/api/admin/restore-from-csv', async (req, res) => {
  try {
    const { requesterRollNo, csvData } = req.body;
    if (!requesterRollNo || !csvData) return res.status(400).json({ error: 'requesterRollNo and csvData required' });
    const requester = await User.findOne({ rollNo: requesterRollNo.trim().toUpperCase() });
    if (!requester || requester.role !== 'admin') return res.status(403).json({ error: 'Access Denied: Admin Only!' });
    const rows = [];
    const stream = Readable.from(csvData);
    await new Promise((resolve, reject) => { stream.pipe(csv()).on('data', (row) => rows.push(row)).on('end', resolve).on('error', reject); });
    if (rows.length === 0) return res.status(400).json({ error: 'No data in CSV' });
    let headers = null;
    for (const row of rows) { const keys = Object.keys(row); if (keys.some(k => /roll/i.test(k) && /no/i.test(k)) || keys.some(k => /date/i.test(k))) { headers = keys; break; } }
    if (!headers) headers = Object.keys(rows[0]);
    const rollIdx = headers.findIndex(h => /roll/i.test(h) && /no/i.test(h));
    const nameIdx = headers.findIndex(h => /name/i.test(h) || /student/i.test(h));
    const subjectIdx = headers.findIndex(h => /subject/i.test(h));
    const dateIdx = headers.findIndex(h => /date/i.test(h));
    const statusIdx = headers.findIndex(h => /status/i.test(h));
    if (rollIdx === -1 || dateIdx === -1 || subjectIdx === -1) return res.status(400).json({ error: 'CSV must have Roll No, Date, Subject columns' });
    const dataRows = [];
    for (const row of rows) {
      const roll = row[headers[rollIdx]]?.trim(), date = row[headers[dateIdx]]?.trim(), subject = row[headers[subjectIdx]]?.trim();
      const status = row[headers[statusIdx]]?.trim() || 'Present';
      const name = nameIdx !== -1 ? row[headers[nameIdx]]?.trim() : '';
      if (!roll || !date || !subject) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (subject.toLowerCase().includes('total') || subject.toLowerCase().includes('student')) continue;
      dataRows.push({ roll, date, subject, status, name });
    }
    if (dataRows.length === 0) return res.status(400).json({ error: 'No valid records in CSV' });
    await Attendance.deleteMany({});
    const recordsToInsert = dataRows.map(r => ({
      rollNo: r.roll, studentName: r.name || 'Unknown',
      subject: mapToCanonical(r.subject), date: r.date,
      status: r.status === 'Duty Leave' ? 'Duty Leave' : 'Present',
      location: { latitude: COLLEGE_LAT, longitude: COLLEGE_LNG },
      ipAddress: 'restore-from-csv', isVerified: true,
      branch: /AIDS/i.test(r.roll) ? 'AIDS' : 'CSE'
    }));
    const chunkSize = 500;
    let inserted = 0;
    for (let i = 0; i < recordsToInsert.length; i += chunkSize) {
      const chunk = recordsToInsert.slice(i, i + chunkSize);
      await Attendance.insertMany(chunk, { ordered: false });
      inserted += chunk.length;
    }
    res.json({ message: `Restored ${inserted} records.`, totalRecords: inserted, studentsAffected: [...new Set(recordsToInsert.map(r => r.rollNo))].length });
  } catch (err) { console.error('Restore error:', err); res.status(500).json({ error: err.message }); }
});

// ---------- Global Error Handlers ----------
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', promise, 'reason:', reason));
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); process.exit(1); });

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} | AI: ${GEMINI_API_KEY ? GEMINI_MODEL : 'disabled'} | PDF: pdfkit`));
