require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const multer = require("multer");
const xlsx = require("xlsx");
const supabase = require("./supabase");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

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

/* ===== HELPERS ===== */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function buildManualRows(body) {
  const orderNos = toArray(body.Order_No);
  const orderDates = toArray(body.Order_Creation_Date);
  const branchCodes = toArray(body.Branch_Code);
  const branchNames = toArray(body.Branch_Name);

  const maxLen = Math.max(
    orderNos.length,
    orderDates.length,
    branchCodes.length,
    branchNames.length
  );

  const rows = [];

  for (let i = 0; i < maxLen; i++) {
    rows.push({
      Order_No: String(orderNos[i] || "").trim(),
      Order_Creation_Date: String(orderDates[i] || "").trim(),
      Branch_Code: String(branchCodes[i] || "").trim(),
      Branch_Name: String(branchNames[i] || "").trim()
    });
  }

  return rows;
}

function buildShipmentRecords(rows, source) {
  return rows.map(row => ({
    reference_number: String(row.Order_No || "").trim(),
    order_creation_date: String(row.Order_Creation_Date || "").trim(),
    branch_code: String(row.Branch_Code || "").trim(),
    branch_name: String(row.Branch_Name || "").trim(),
    barcode: String(row.Order_No || "").trim(),
    source
  }));
}

function buildTrackingRecords(rows) {
  return rows.map(row => ({
    reference_number: String(row.Order_No || "").trim(),
    status: "Created",
    location: "QAS-TPCS"
  }));
}

function validateRows(rows) {
  return rows.filter(
    row =>
      !String(row.Order_No || "").trim() ||
      !String(row.Order_Creation_Date || "").trim() ||
      !String(row.Branch_Code || "").trim() ||
      !String(row.Branch_Name || "").trim()
  );
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
app.get("/dashboard", requireLogin, async (req, res) => {
  try {
    const user = req.session.user;

    const { data: shipments, error: shipmentsError } = await supabase
      .from("shipments")
      .select("*");

    const { data: pods, error: podsError } = await supabase
      .from("pods")
      .select("*");

    if (shipmentsError || podsError) {
      console.error("Dashboard query error:", shipmentsError || podsError);
      return res.status(500).send("Error loading dashboard data");
    }

    const stickerCount = shipments ? shipments.length : 0;
    const podCount = pods ? pods.length : 0;

    let rows = "";

    if (shipments && shipments.length > 0) {
      shipments
        .slice()
        .reverse()
        .slice(0, 10)
        .forEach(item => {
          const date = item.created_at
            ? new Date(item.created_at).toLocaleDateString("en-ZA")
            : "";

          rows += `
            <tr>
              <td>${item.source || "Shipment"}</td>
              <td>${item.reference_number || item.barcode || ""}</td>
              <td>${date}</td>
            </tr>
          `;
        });
    }

    let html = fs.readFileSync(
      path.join(__dirname, "../frontend/dashboard.html"),
      "utf8"
    );

    html = html
      .replace("{{USER}}", user.username)
      .replace("{{ROLE}}", user.role)
      .replace("{{STICKERS}}", String(stickerCount))
      .replace("{{PODS}}", String(podCount))
      .replace("{{ROWS}}", rows);

    html = html.replace("{{ADMIN}}", "");

    res.send(html);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Server error loading dashboard");
  }
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

/* ===== BATCH UPLOAD ===== */
app.post("/batch", requireLogin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded.");
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows.length) {
      return res.status(400).send("Excel file contains no data.");
    }

    const requiredColumns = [
      "Order_No",
      "Order_Creation_Date",
      "Branch_Code",
      "Branch_Name"
    ];

    const missingColumns = requiredColumns.filter(
      col => !rows[0]?.hasOwnProperty(col)
    );

    if (missingColumns.length > 0) {
      return res.status(400).send(
        `Missing required columns: ${missingColumns.join(", ")}`
      );
    }

    const invalidRows = validateRows(rows);
    if (invalidRows.length > 0) {
      return res.status(400).send("Some rows have missing required values.");
    }

    const shipmentRecords = buildShipmentRecords(rows, "batch");
    const trackingRecords = buildTrackingRecords(rows);

    const { error: shipmentError } = await supabase
      .from("shipments")
      .insert(shipmentRecords);

    if (shipmentError) {
      console.error("Supabase batch insert error:", shipmentError);
      return res.status(500).send("Error saving batch shipment data");
    }

    const { error: trackingError } = await supabase
      .from("tracking")
      .insert(trackingRecords);

    if (trackingError) {
      console.error("Supabase batch tracking insert error:", trackingError);
      return res.status(500).send("Error saving batch tracking data");
    }

    res.send(`Batch upload successful. ${shipmentRecords.length} rows saved.`);
  } catch (err) {
    console.error("Batch route error:", err);
    res.status(500).send("Server error in batch upload");
  }
});

/* ===== MANUAL GENERATION SAVE ===== */
app.post("/manual", requireLogin, async (req, res) => {
  try {
    const rows = buildManualRows(req.body);

    if (!rows.length) {
      return res.status(400).send("No manual rows received.");
    }

    const invalidRows = validateRows(rows);
    if (invalidRows.length > 0) {
      return res.status(400).send("Some manual rows have missing required values.");
    }

    const shipmentRecords = buildShipmentRecords(rows, "manual");
    const trackingRecords = buildTrackingRecords(rows);

    const { error: shipmentError } = await supabase
      .from("shipments")
      .insert(shipmentRecords);

    if (shipmentError) {
      console.error("Supabase insert error:", shipmentError);
      return res.status(500).send("Error saving manual sticker data");
    }

    const { error: trackingError } = await supabase
      .from("tracking")
      .insert(trackingRecords);

    if (trackingError) {
      console.error("Supabase tracking insert error:", trackingError);
      return res.status(500).send("Error saving tracking data");
    }

    res.send("Manual sticker data saved successfully.");
  } catch (err) {
    console.error("Manual route error:", err);
    res.status(500).send("Server error in manual generation");
  }
});

/* ===== TRACK LOOKUP ===== */
app.get("/track/:code", async (req, res) => {
  try {
    const code = req.params.code.trim();

    const { data, error } = await supabase
      .from("tracking")
      .select("*")
      .eq("reference_number", code)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Tracking fetch error:", error);
      return res.status(500).json([]);
    }

    res.json(data || []);
  } catch (err) {
    console.error("Track route error:", err);
    res.status(500).json([]);
  }
});

/* ===== TEST DB ===== */
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