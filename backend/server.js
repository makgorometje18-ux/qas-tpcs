require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const supabase = require("./supabase");

const app = express();

/* ===== BASIC MIDDLEWARE ===== */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

/* ===== SESSION ===== */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: true
  })
);

/* ===== LOGIN PROTECTION ===== */
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

/* ===== HOME ===== */
app.get("/", (req, res) => {
  res.send(`
    <h1>QAS-TPCS Server Running</h1>
    <p>If you see this page, your server is working correctly.</p>
    <p><a href="/login">Go to Login</a></p>
  `);
});

/* ===== LOGIN PAGE ===== */
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

/* ===== LOGIN POST (DATABASE LOGIN) ===== */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .eq("password", password)
      .single();

    if (error || !data) {
      return res.send("Invalid login");
    }

    req.session.user = {
      username: data.username,
      role: data.role
    };

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).send("Server error during login");
  }
});

/* ===== LOGOUT ===== */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* ===== DASHBOARD ===== */
app.get("/dashboard", requireLogin, (req, res) => {
  const user = req.session.user;

  let html = fs.readFileSync(
    path.join(__dirname, "../frontend/dashboard.html"),
    "utf8"
  );

  html = html
    .replace("{{USER}}", user.username)
    .replace("{{ROLE}}", user.role)
    .replace("{{STICKERS}}", "0")
    .replace("{{PODS}}", "0")
    .replace("{{ROWS}}", "");

  html = html.replace("{{ADMIN}}", "");

  res.send(html);
});

/* ===== SAFE PAGE ROUTES ===== */
app.get("/manual", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/manual.html"));
});

app.get("/batch", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/batch.html"));
});

app.get("/tracking", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/tracking.html"));
});

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat.html"));
});

app.get("/chat-service", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat-service.html"));
});

app.get("/chat-tracking", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/chat-tracking.html"));
});

/* ===== TEMPORARY PLACEHOLDER ROUTES FOR VERCEL ===== */
app.get("/jobs", requireLogin, (req, res) => {
  res.send("Jobs page will be connected after storage migration.");
});

app.get("/manifest", requireLogin, (req, res) => {
  res.send("Manifest page will be connected after storage migration.");
});

app.post("/manifest-sign", requireLogin, (req, res) => {
  res
    .status(501)
    .send("Manifest signing is temporarily disabled on this Vercel version.");
});

app.get("/download/:filename", requireLogin, (req, res) => {
  res
    .status(501)
    .send("File download is temporarily disabled on this Vercel version.");
});

app.get("/pod-history", requireLogin, (req, res) => {
  res.send("POD history will be connected after storage migration.");
});

app.get("/pod-delete", requireLogin, (req, res) => {
  res
    .status(501)
    .send("POD delete is temporarily disabled on this Vercel version.");
});

app.get("/pod-delete/:podNo", requireLogin, (req, res) => {
  res
    .status(501)
    .send("POD delete is temporarily disabled on this Vercel version.");
});

app.post("/batch", requireLogin, (req, res) => {
  res
    .status(501)
    .send("Batch upload is temporarily disabled on this Vercel version.");
});

app.post("/manual", requireLogin, (req, res) => {
  res
    .status(501)
    .send("Manual sticker generation is temporarily disabled on this Vercel version.");
});

app.get("/track/:code", requireLogin, (req, res) => {
  res.json([]);
});

app.get("/test-db", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("*");

    if (error) {
      console.error("Supabase query error:", error);
      return res.status(500).json({
        source: "supabase",
        message: error.message,
        details: error.details || null,
        hint: error.hint || null,
        code: error.code || null
      });
    }

    return res.json(data);
  } catch (err) {
    console.error("Server crash in /test-db:", err);
    return res.status(500).json({
      source: "server",
      message: err.message
    });
  }
});

module.exports = app;