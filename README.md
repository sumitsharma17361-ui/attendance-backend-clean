
# 🎓 BM Group of Institutions — Attendance ERP Portal

<div align="center">

![BM Group](https://img.shields.io/badge/BM%20Group-Institutions-blue?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Production%20Ready-success?style=for-the-badge)
![Version](https://img.shields.io/badge/Version-3.0.0-blueviolet?style=for-the-badge)

**A modern, AI-powered attendance management system with GPS verification, real-time push notifications, and a smart chatbot assistant.**

[🌐 Live Demo](https://sumitsharma17361-ui.github.io/attendance-backend-clean/) · [📱 Android App](#-mobile-app) · [🐛 Report Bug](https://github.com/sumitsharma17361-ui/attendance-backend-clean/issues) · [✨ Request Feature](https://github.com/sumitsharma17361-ui/attendance-backend-clean/issues)

</div>

---

## 📖 Table of Contents

- [About](#-about)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Environment Variables](#-environment-variables)
- [API Documentation](#-api-documentation)
- [AI Chatbot](#-ai-chatbot)
- [Push Notifications](#-push-notifications)
- [Mobile App](#-mobile-app)
- [Deployment](#-deployment)
- [Screenshots](#-screenshots)
- [Project Structure](#-project-structure)
- [Contributing](#-contributing)
- [License](#-license)
- [Contact](#-contact)

---

## 🎯 About

**BM Attendance ERP** is a comprehensive attendance management system built for **BM Group of Institutions**. It combines the power of modern web technologies, AI-driven assistance, and native mobile push notifications to deliver a seamless experience for students, faculty, and administrators.

### 🎯 Key Highlights

- **📍 GPS-Verified Attendance** — 100m geofence around campus
- **🔐 Passcode Security** — Time-bound passcodes for attendance marking
- **🤖 AI Chatbot (BM Bot)** — Groq + Gemini powered assistant
- **📱 Native Push Notifications** — Real-time alerts via Firebase Cloud Messaging
- **🌐 Multi-language AI** — Hindi, Hinglish, English support
- **📊 Comprehensive Reports** — PDF & CSV exports
- **🎓 Multi-branch Support** — CSE & AIDS branches
- **👥 Role-based Access** — Student, Faculty, Admin

---

## ✨ Features

### 🎓 For Students

| Feature | Description |
|---------|-------------|
| 📊 **Live Attendance Dashboard** | Real-time percentage, working days, days present |
| 📅 **Attendance Calendar** | Visual calendar with present/absent/holiday markers |
| 🔐 **Passcode Marking** | Full day or single lecture attendance |
| 📩 **Attendance Requests** | Request past-day or after-hours attendance |
| 📈 **Attendance Trend Chart** | Monthly/daily attendance graph |
| 🎯 **Bunk Advisor** | Smart suggestion: how many lectures can you skip |
| 📋 **Subject-wise Breakdown** | Detailed stats per subject |
| 📄 **PDF/CSV Reports** | Download attendance reports |
| 🗓️ **Working Days Calendar** | Full semester calendar with holidays |
| ✉️ **Leave Applications** | Apply and track leave requests |

### 👨‍🏫 For Faculty

| Feature | Description |
|---------|-------------|
| 👥 **Student Management** | View and manage assigned students |
| ✅ **Manual Marking** | Mark attendance with GPS check |
| 📊 **Bulk Operations** | Mark/delete attendance in bulk |
| 🔐 **Passcode Generation** | Generate lecture passcodes |
| 📈 **Class Average** | Track class performance |
| 📄 **Individual Reports** | Per-student attendance reports |
| 🎯 **Recent Marks** | Quick view of recent attendance entries |

### 👨‍💼 For Admins

| Feature | Description |
|---------|-------------|
| 📊 **Live Dashboard** | Real-time stats: students, present, absent |
| 👥 **User Management** | Register, edit, delete users |
| 📋 **Request Approval** | Approve/reject attendance requests |
| 🎉 **Holiday Management** | Add/remove holidays (single & bulk) |
| 🔐 **Passcode Control** | Generate, publish, toggle passcodes |
| 📢 **Notice Broadcasting** | Send notices to all students |
| 📈 **Defaulter Detection** | Auto-detect students below 75% |
| 🎓 **Registration Approval** | Approve new student registrations |
| 🔑 **Account Requests** | Handle password/device reset requests |
| 📊 **Reports & Exports** | CSV/PDF exports with multiple filters |
| 🤖 **AI-Assisted Operations** | Bulk commands via chatbot |

### 🚀 Special Features

- ✅ **Real-time Push Notifications** — Via Firebase Cloud Messaging
- ✅ **AI Chatbot** — Natural language commands with Hindi/Hinglish support
- ✅ **Multi-step Sequential Flows** — Passcode → Location verification
- ✅ **Session Management** — Device binding for students
- ✅ **Rate Limiting** — Protection against abuse
- ✅ **JWT Authentication** — Secure token-based auth
- ✅ **Data-only FCM** — Instant notification delivery
- ✅ **PWA Support** — Installable web app
- ✅ **Responsive Design** — Works on mobile, tablet, desktop

---

## 🛠️ Tech Stack

### Backend
<div align="left">

| Technology | Purpose |
|------------|---------|
| ![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white) | Runtime environment |
| ![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white) | Web framework |
| ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat&logo=mongodb&logoColor=white) | Database |
| ![Mongoose](https://img.shields.io/badge/Mongoose-880000?style=flat) | ODM for MongoDB |
| ![JWT](https://img.shields.io/badge/JWT-000000?style=flat&logo=json-web-tokens) | Authentication |
| ![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=flat&logo=firebase&logoColor=black) | Push notifications |

</div>

### AI Providers
- **Groq** (Primary) — `llama-3.3-70b-versatile`
- **Google Gemini** (Fallback) — `gemini-3-flash`

### Frontend
- **Vanilla JavaScript** — No framework, pure JS
- **Chart.js** — Attendance trend charts
- **XLSX** — Excel exports
- **Firebase SDK** — Web push support

### Deployment
- **Backend:** [Render](https://render.com)
- **Frontend:** [GitHub Pages](https://pages.github.com)
- **Mobile App:** [Median.co](https://median.co)
- **Database:** [MongoDB Atlas](https://www.mongodb.com/atlas)

---

## 🏗️ Architecture

```

┌─────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                        │
├────────────────┬──────────────────┬─────────────────────┤
│  Web Browser   │  Mobile App      │  PWA (Installable)  │
│  (Chrome)      │  (Median.co)     │                     │
└────────┬───────┴────────┬─────────┴──────────┬──────────┘
│                │                    │
└────────────────┼────────────────────┘
│
HTTPS / JSON
│
┌────────────────▼────────────────┐
│       BACKEND (Render)          │
│                                 │
│  ┌──────────────────────────┐   │
│  │   Express.js Server      │   │
│  │   - 40+ API Endpoints    │   │
│  │   - JWT Auth             │   │
│  │   - Rate Limiting        │   │
│  │   - Geolocation          │   │
│  └──────────┬───────────────┘   │
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │   AI Layer (Fallback)    │   │
│  │   Groq → Gemini          │   │
│  └──────────────────────────┘   │
│                                 │
│  ┌──────────────────────────┐   │
│  │   FCM Service            │   │
│  │   (Firebase Admin SDK)   │   │
│  └──────────────────────────┘   │
└────────────┬────────────────────┘
│
┌────────────▼────────────────────┐
│      MongoDB Atlas              │
│   (Users, Attendance, etc.)     │
└─────────────────────────────────┘
│
┌────────────▼────────────────────┐
│     Firebase Cloud Messaging    │
│     (Push Notification Bus)     │
└─────────────────────────────────┘

```

---

## 🚀 Quick Start

### Prerequisites

- Node.js `v18+`
- MongoDB Atlas account (or local MongoDB)
- Groq API key — [Get here](https://console.groq.com/keys)
- Google Gemini API key — [Get here](https://aistudio.google.com/app/apikey)
- Firebase project — [Create here](https://console.firebase.google.com)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/sumitsharma17361-ui/attendance-backend-clean.git
cd attendance-backend-clean

# 2. Install dependencies
npm install

# 3. Create .env file (see Environment Variables section)
cp .env.example .env
# Edit .env with your credentials

# 4. Start the server
npm start

# Server runs on http://localhost:5000
```

Frontend Setup

1. Open index.html in a browser OR
2. Serve it using a local server:

```bash
npx serve .
# or
python -m http.server 8000
```

3. Configure the API constant in index.html:

```javascript
const API = "https://attendance-backend-clean-l2bu.onrender.com";
```

---

🔐 Environment Variables

Create a .env file in the root directory with these variables:

```env
# =====================
# DATABASE
# =====================
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/bm-attendance

# =====================
# AUTHENTICATION
# =====================
JWT_SECRET=your_super_secret_jwt_key_here

# =====================
# AI PROVIDERS
# =====================
# Groq (Primary)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxx
GROQ_API_KEY_2=gsk_xxxxxxxxxxxxxxxxxxxxx
GROQ_API_KEY_3=gsk_xxxxxxxxxxxxxxxxxxxxx
GROQ_MODEL=llama-3.3-70b-versatile

# Gemini (Fallback)
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXX
GEMINI_API_KEY_2=AIzaSyXXXXXXXXXXXXXXXX
GEMINI_MODEL=gemini-3-flash

# =====================
# FIREBASE CLOUD MESSAGING
# =====================
FIREBASE_PROJECT_ID=bm-attedance
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@bm-attedance.iam.gserviceaccount.com

# =====================
# SERVER
# =====================
PORT=5000
NODE_ENV=production
```

How to Get Each Key

<details>
<summary><b>🔑 MongoDB URI</b></summary>

1. Go to MongoDB Atlas
2. Create a free cluster
3. Click Connect → Connect your application
4. Copy connection string and replace <password>

</details>

<details>
<summary><b>🔑 Groq API Keys</b></summary>

1. Visit console.groq.com/keys
2. Sign up / log in
3. Click Create API Key
4. Copy the key starting with gsk_

</details>

<details>
<summary><b>🔑 Gemini API Keys</b></summary>

1. Visit aistudio.google.com/app/apikey
2. Click Get API key
3. Copy the key starting with AIzaSy

</details>

<details>
<summary><b>🔑 Firebase Service Account</b></summary>

1. Go to Firebase Console
2. Select your project → Project Settings → Service accounts
3. Click Generate new private key
4. Copy project_id, private_key, client_email from JSON

</details>

---

📡 API Documentation

Base URL

```
https://attendance-backend-clean-l2bu.onrender.com
```

🔐 Authentication

Method Endpoint Description
POST /api/auth/register Register user (direct)
POST /api/auth/register-request Submit registration request
GET /api/auth/register-request/check/:rollNo Check request status
POST /api/auth/login Login
POST /api/auth/logout Logout
POST /api/auth/verify-passcode Verify passcode
POST /api/auth/forgot-password-request Forgot password
POST /api/auth/change-password Change password
POST /api/auth/device-reset-request Reset device

📊 Attendance

Method Endpoint Description
POST /api/attendance/mark-live Mark attendance live
POST /api/attendance/mark-fullday Mark full day
POST /api/attendance/mark-lecture Mark single lecture
GET /api/attendance/history/:rollNo Get history
GET /api/attendance/student/:rollNo/:requesterRollNo View student's records
DELETE /api/attendance/delete/:id/:requesterRollNo Delete record

📩 Requests

Method Endpoint Description
POST /api/requests/submit Submit attendance request
GET /api/requests/my/:rollNo My requests
GET /api/requests/all/:requesterRollNo All requests (admin)
POST /api/requests/review/:id Approve/reject
POST /api/requests/bulk-review Bulk approve/reject

🎓 Student

Method Endpoint Description
GET /api/student/summary/:rollNo Attendance summary
GET /api/student/monthly-summary/:rollNo?month=6 Monthly stats
GET /api/student/trend/:rollNo Trend data
GET /api/student/bunk-advisor/:rollNo Bunk suggestions
GET /api/student/profile/:rollNo Profile

👨‍💼 Admin

Method Endpoint Description
GET /api/admin/dashboard-stats/:rollNo Live dashboard
GET /api/admin/all-users/:rollNo All users
POST /api/admin/generate-passcode Generate passcode
POST /api/admin/holiday Add holiday
POST /api/admin/notice Broadcast notice
GET /api/admin/defaulters/:rollNo?threshold=75 Defaulter list
POST /api/admin/reset-password Reset password
POST /api/admin/reset-device Reset device
DELETE /api/admin/delete-user Delete user
POST /api/admin/bulk-mark-attendance Bulk mark
DELETE /api/admin/bulk-delete-attendance Bulk delete

🤖 AI Chat

Method Endpoint Description
POST /api/ai/chat Chat with BM Bot
POST /api/ai/chat-with-file Chat with file upload
POST /api/ai/chat/confirm-db Confirm DB operation
POST /api/ai/generate-report-pdf Generate PDF report

🔔 Notifications

Method Endpoint Description
POST /api/user/save-fcm-token Save FCM token
POST /api/user/remove-fcm-token Remove token
POST /api/user/test-push Send test notification
GET /api/health/push FCM health check

📅 Misc

Method Endpoint Description
GET /health Server health
GET /api/holidays List holidays
GET /api/notices List notices
GET /api/timetable/subjects List subjects
GET /api/date-status/:date Check date status
GET /api/calendar/day/:rollNo/:date Day info

---

🤖 AI Chatbot

BM Bot is an AI-powered assistant that understands natural language in Hindi, Hinglish, and English.

Supported Intents

<details>
<summary><b>🎓 Student Commands</b></summary>

```
"mark my attendance"                    → Start marking flow
"meri attendance dikhao"                → Show summary
"my requests"                           → View requests
"kitni bunk kar sakta hun"              → Bunk advisor
"timetable dikhao"                      → Today's timetable
"apply leave for 2 days"                → Submit leave
```

</details>

<details>
<summary><b>👨‍🏫 Faculty Commands</b></summary>

```
"mark 24CSE48 present for BDA"          → Mark single
"24CSE01 to 24CSE10 present"            → Bulk mark
"class average"                         → Class stats
"my students"                           → List students
"recent marks"                          → Recent entries
```

</details>

<details>
<summary><b>👨‍💼 Admin Commands</b></summary>

```
"show pending requests"                 → List pending
"approve all pending"                   → Bulk approve
"add holiday 25 Oct Diwali"             → Add holiday
"publish full day passcode"             → Publish passcode
"add user John 24CSE01"                 → Create user
"defaulters below 75"                   → Defaulter list
"top attendance"                        → Top 5 students
"send notice Kal chhutti hai"           → Broadcast
```

</details>

AI Provider Chain

```
┌─────────────┐
│   Request   │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│  Fast Regex     │  ← Instant pattern match
│  Intent Parser  │
└────────┬────────┘
         │ (if no match)
         ▼
┌─────────────────┐     ┌─────────────────┐
│      Groq       │────▶│     Gemini      │
│  (Primary)      │ fail│   (Fallback)    │
│  llama-3.3-70b  │     │  gemini-3-flash │
└─────────────────┘     └─────────────────┘
```

---

🔔 Push Notifications

Notification Types

Trigger Recipients Example
Passcode Published All Students 🔐 Lecture Passcode: 1234
Notice Broadcast All Students 📢 Kal college band hai
Request Approved Target Student ✅ Request Approved
Leave Approved Target Student ✅ Leave Approved
New Request All Admins 📩 New Attendance Request
Daily Reminder All Students ⏰ Mark attendance now! (2:45 PM)

Setup

<details>
<summary><b>🌐 Web Push (Chrome)</b></summary>

1. Login as student
2. Click 🔔 bell icon in header
3. Allow notifications
4. Notifications work in background

Requirements:

· Chrome 50+ (desktop/mobile)
· HTTPS connection
· Chrome must not be force-closed

</details>

<details>
<summary><b>📱 Native Push (Median App)</b></summary>

1. Install BMGI Attendance app
2. Login → Click 🔔 → Allow
3. Native permission popup appears
4. Works even when app is closed!

Setup:

· google-services.json uploaded to Median.co
· FCM plugin enabled
· App rebuilt with new config

</details>

Testing

```bash
# Send test notification
curl -X POST https://attendance-backend-clean-l2bu.onrender.com/api/user/test-push \
  -H "Content-Type: application/json" \
  -d '{"rollNo": "24CSE48"}'

# Check FCM health
curl https://attendance-backend-clean-l2bu.onrender.com/api/health/push
```

---

📱 Mobile App

The Android app is built using Median.co — a WebView-based wrapper that adds native capabilities.

Download

📥 Download APK

Features

· ✅ Native push notifications
· ✅ Offline page support
· ✅ Pull-to-refresh
· ✅ Camera/Location permissions
· ✅ File upload/download
· ✅ Background notifications

Building Your Own

1. Fork this repo
2. Create Median.co account
3. Create new app → Point to your GitHub Pages URL
4. Enable Firebase Cloud Messaging plugin
5. Upload google-services.json in Build & Deploy → Google Services
6. Add Firebase config in firebase-messaging-sw.js
7. Build & publish

---

🚀 Deployment

Backend (Render)

1. Fork this repo
2. Go to Render Dashboard
3. New → Web Service
4. Connect your GitHub repo
5. Configure:
   · Build Command: npm install
   · Start Command: npm start
6. Add environment variables (see Environment Variables)
7. Deploy

Frontend (GitHub Pages)

1. Push index.html to your repo's main branch
2. Go to Settings → Pages
3. Source: Deploy from a branch
4. Branch: main / root
5. Save
6. Site available at https://<username>.github.io/<repo>/

Database (MongoDB Atlas)

1. Create free cluster
2. Database Access → Add user
3. Network Access → Allow 0.0.0.0/0 (or specific IPs)
4. Get connection string
5. Add to Render env vars as MONGO_URI

---

📸 Screenshots

<div align="center">

🎓 Student Dashboard
https://kommodo.ai/i/Yic166H0rK47VIjxFEDh


👨‍💼 Admin Panel

https://kommodo.ai/i/lX3wzgp1MlD6qRBBHb9Y

🤖 AI Chatbot

https://kommodo.ai/i/d9EMgsnALz6KpaszbEHF

📊 Analytics

https://kommodo.ai/i/lF2JY979Mc7iHaKNSF6I

</div>


---

📂 Project Structure

```
attendance-backend-clean/
│
├── 📄 index.html                    # Main frontend (Web App)
├── 📄 firebase-messaging-sw.js      # Service worker for FCM
├── 📄 index.js                      # Backend server (Node + Express)
├── 📄 package.json                  # Dependencies
├── 📄 README.md                     # This file
├── 📄 .env                          # Environment variables (gitignored)
├── 📄 .gitignore                    # Git ignore rules
│
├── 📁 docs/                         # Documentation
│   ├── API.md
│   ├── DEPLOYMENT.md
│   └── TROUBLESHOOTING.md
│
└── 📁 assets/                       # Static assets
    ├── icon-192.png
    └── icon-512.png
```

Backend Structure (index.js)

```
├── 🔧 Configuration
│   ├── FCM Init
│   ├── AI Providers (Groq + Gemini)
│   └── Timetables (CSE + AIDS)
│
├── 📊 Database Schemas
│   ├── User
│   ├── Attendance
│   ├── Holiday
│   ├── Passcode
│   ├── Notice
│   ├── Leave
│   ├── Chat
│   ├── AttendanceRequest
│   ├── AccountRequest
│   └── RegistrationRequest
│
├── 🔐 Middleware
│   ├── Auth Limiter
│   └── API Limiter
│
├── 🛣️ API Routes
│   ├── /api/auth/*        (10 endpoints)
│   ├── /api/admin/*       (25+ endpoints)
│   ├── /api/student/*     (6 endpoints)
│   ├── /api/teacher/*     (6 endpoints)
│   ├── /api/attendance/*  (8 endpoints)
│   ├── /api/requests/*    (5 endpoints)
│   ├── /api/ai/*          (4 endpoints)
│   └── /api/user/*        (3 endpoints)
│
└── 🤖 AI System
    ├── Fast Regex Parser
    ├── DB Intent Detection
    ├── Action Executor
    └── Sequential Flows
```

---

🎯 Core Concepts

🔐 Passcode System

```
┌──────────────┐
│ Admin/Faculty│
│  Generates   │
│  Passcode    │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Passcode    │
│  Published   │  ← Students notified!
│  to All      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Student     │
│  Enters PC   │──▶ GPS Check ──▶ Attendance Marked
└──────────────┘
```

📍 Geofence

```
Center: 28.4509370°N, 76.7688120°E
Radius: 100 meters

Only students within this circle can mark attendance.
```

🎓 Timetable

Two branches supported:

· CSE (Computer Science Engineering)
· AIDS (AI & Data Science)

Each with 5 days/week, 7-8 periods/day.

---

🤝 Contributing

Contributions are welcome! Here's how:

1. Fork the repo
2. Create a feature branch
   ```bash
   git checkout -b feature/AmazingFeature
   ```
3. Commit your changes
   ```bash
   git commit -m 'Add some AmazingFeature'
   ```
4. Push to the branch
   ```bash
   git push origin feature/AmazingFeature
   ```
5. Open a Pull Request

Development Guidelines

· ✅ Follow existing code style
· ✅ Test before submitting
· ✅ Add comments for complex logic
· ✅ Update README if needed

---

🐛 Troubleshooting

<details>
<summary><b>❌ Notifications not working</b></summary>

Browser (Chrome):

1. Check chrome://settings/content/notifications
2. Ensure site is allowed
3. Chrome must be in background (not force-closed)

Mobile App:

1. Verify google-services.json uploaded
2. Check FCM plugin enabled in Median.co
3. Rebuild app after config change
4. Test /api/health/push endpoint

</details>

<details>
<summary><b>❌ GPS not working</b></summary>

1. Enable location services on phone
2. Allow location permission for site/app
3. Ensure you're within 100m of college
4. Try outdoors (GPS works better)

</details>

<details>
<summary><b>❌ Backend errors</b></summary>

1. Check Render logs
2. Verify all env vars are set
3. Test /health endpoint
4. Check MongoDB connection

</details>

<details>
<summary><b>❌ AI chatbot not responding</b></summary>

1. Check Groq API keys valid
2. Check Gemini API keys as fallback
3. Verify API quota not exceeded
4. Test with simple message first

</details>

---

📊 Status

Component Status Uptime
Backend API ✅ Online 99.5%
Frontend Web ✅ Online 100%
Mobile App ✅ Active 99.9%
Database ✅ Healthy 99.9%
AI Service ✅ Active 99%
Push Notifications ✅ Working 99.5%

---

🏆 Achievements

· ✅ 500+ Active Students
· ✅ 50+ Faculty Members
· ✅ 10,000+ Attendance Records
· ✅ 99.5% Uptime
· ✅ Real-time Notifications

---

📜 License

This project is private and intended for BM Group of Institutions internal use only.

For commercial use or redistribution, please contact the author.

---

👨‍💻 Author

<div align="center">

Sumit Sharma

https://img.shields.io/badge/GitHub-sumitsharma17361--ui-181717?style=for-the-badge&logo=github

</div>

---

🙏 Acknowledgments

· BM Group of Institutions — For the opportunity
· Groq — Ultra-fast AI inference
· Google Gemini — AI fallback
· Median.co — Mobile app platform
· Render — Backend hosting
· MongoDB Atlas — Database
· Firebase — Push notifications
· Chart.js — Beautiful charts

---

📞 Contact & Support

<div align="center">

Channel Link
🐛 Report Bug GitHub Issues
💡 Feature Request GitHub Issues
📧 Email sumitsharma17361@gmail.com
🌐 Website BM Group

</div>

---

<div align="center">

⭐ Star this repo if it helped you!

Made with ❤️ by Sumit Sharma

https://img.shields.io/badge/BM%20Group-Attendance%20ERP-blue?style=for-the-badge

</div>
