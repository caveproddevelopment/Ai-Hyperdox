const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }      = require("firebase-admin/app");
const { getAuth }            = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { defineSecret }       = require("firebase-functions/params");
const bcrypt                 = require("bcrypt");

initializeApp();

const db = getFirestore();

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");

const SALT_ROUNDS = 12;
const MAX_HISTORY = 5;

const GAS_URL =
  "https://script.google.com/macros/s/AKfycbzaw6VLnW2tu4_7y4DxCoEpjZnhJosQSZmuYBX9dMx5mDz26zjRfVEw8LNnNAyXxz8/exec";

const SITE_URL  = "https://ai-hyperdox.vercel.app";
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

async function callGAS(payload) {
  const res = await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type": "text/plain" },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GAS responded with ${res.status}`);
}

function generateToken() {
  return Math.random().toString(36).substring(2) +
         Math.random().toString(36).substring(2) +
         Date.now().toString(36);
}

// ════════════════════════════════════════════════════════════════
//  sendVerificationEmail
// ════════════════════════════════════════════════════════════════

exports.sendVerificationEmail = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    const { uid, name } = request.data;
    if (!uid) throw new HttpsError("invalid-argument", "uid is required");

    const user = await getAuth().getUser(uid);
    if (user.emailVerified) return { success: true, message: "Already verified" };

    const actionCodeSettings = {
      url: "https://ai-hyperdox.vercel.app/signin",
      handleCodeInApp: false,
    };

    const link = await getAuth().generateEmailVerificationLink(
      user.email,
      actionCodeSettings
    );

    await callGAS({ type: "verification", email: user.email, link, name: name || "" });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  sendPasswordResetEmail
// ════════════════════════════════════════════════════════════════

exports.sendPasswordResetEmail = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    const { email, name } = request.data;
    if (!email) throw new HttpsError("invalid-argument", "email is required");

    try {
      const firebaseLink = await getAuth().generatePasswordResetLink(email);
      const token = generateToken();
      await db.collection("passwordResets").doc(token).set({
        email,
        link:      firebaseLink,
        createdAt: Date.now(),
        expiresAt: Date.now() + EXPIRY_MS,
        used:      false,
      });
      const customLink = `${SITE_URL}/reset-password?token=${token}`;
      await callGAS({ type: "reset", email, link: customLink, name: name || "" });
      return { success: true };
    } catch (err) {
      console.error("sendPasswordResetEmail error:", err);
      if (err.code === "auth/user-not-found") {
        throw new HttpsError("not-found", "No account found with that email address.");
      }
      if (err.code === "auth/invalid-email") {
        throw new HttpsError("invalid-argument", "Invalid email address.");
      }
      if (err.code === "auth/too-many-requests") {
        throw new HttpsError("resource-exhausted", "Too many requests. Please try again later.");
      }
      if (err.message?.includes("GAS responded")) {
        throw new HttpsError("unavailable", "Email service temporarily unavailable.");
      }
      throw new HttpsError("internal", err.message || "Unable to send reset email. Please try again later.");
    }
  }
);

// HTTP public fallback — accepts POST { email, name }
exports.sendPasswordResetEmailHttp = onRequest(
  { cors: true, invoker: ["public"] },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const { email, name } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });
    try {
      const firebaseLink = await getAuth().generatePasswordResetLink(email);
      const token = generateToken();
      await db.collection("passwordResets").doc(token).set({
        email,
        link:      firebaseLink,
        createdAt: Date.now(),
        expiresAt: Date.now() + EXPIRY_MS,
        used:      false,
      });
      const customLink = `${SITE_URL}/reset-password?token=${token}`;
      await callGAS({ type: "reset", email, link: customLink, name: name || "" });
      return res.json({ success: true });
    } catch (err) {
      console.error("sendPasswordResetEmailHttp error:", err);
      if (err.code === "auth/user-not-found") return res.status(404).json({ error: "No account found with that email address." });
      if (err.code === "auth/invalid-email")   return res.status(400).json({ error: "Invalid email address." });
      if (err.code === "auth/too-many-requests") return res.status(429).json({ error: "Too many requests. Please try again later." });
      if (err.message?.includes("GAS responded")) return res.status(503).json({ error: "Email service temporarily unavailable." });
      return res.status(500).json({ error: err.message || "Unable to send reset email." });
    }
  }
);

// ════════════════════════════════════════════════════════════════
//  validateResetToken
// ════════════════════════════════════════════════════════════════

exports.validateResetToken = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    const { token } = request.data;
    if (!token) throw new HttpsError("invalid-argument", "token is required");

    const snap = await db.collection("passwordResets").doc(token).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invalid reset link.");
    }

    const data = snap.data();

    if (data.used) {
      throw new HttpsError("failed-precondition", "This link has already been used.");
    }

    if (Date.now() > data.expiresAt) {
      throw new HttpsError("deadline-exceeded", "This link has expired.");
    }

    await db.collection("passwordResets").doc(token).update({ used: true });

    return { link: data.link, email: data.email };
  }
);

// ════════════════════════════════════════════════════════════════
//  checkPasswordHistory
// ════════════════════════════════════════════════════════════════
// NOTE: token is already marked used:true by validateResetToken on
// page load — so we only pull email from it, no used/expiry recheck

exports.checkPasswordHistory = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    const { token, newPassword } = request.data;
    if (!token || !newPassword) {
      throw new HttpsError("invalid-argument", "Missing token or password.");
    }

    // Pull email from the reset doc — already validated on page load
    const snap = await db.collection("passwordResets").doc(token).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invalid reset token.");
    }
    const { email } = snap.data();

    // Get uid from email
    const user = await getAuth().getUserByEmail(email);
    const { uid } = user;

    // Fetch password hash history for this user
    const historySnap = await db.collection("passwordHistory").doc(uid).get();
    if (!historySnap.exists) {
      // No history yet — first reset ever, allow it
      return { reused: false };
    }

    const { hashes = [] } = historySnap.data();

    // Compare new password against all stored hashes in parallel
    const results = await Promise.all(
      hashes.map(hash => bcrypt.compare(newPassword, hash))
    );

    return { reused: results.some(Boolean) };
  }
);

// ════════════════════════════════════════════════════════════════
//  resetPasswordAndSaveHistory
// ════════════════════════════════════════════════════════════════
// Called after confirmPasswordReset succeeds on client —
// hashes and stores the new password in Firestore history

exports.resetPasswordAndSaveHistory = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    const { token, newPassword } = request.data;
    if (!token || !newPassword) {
      throw new HttpsError("invalid-argument", "Missing token or password.");
    }

    // Pull email from the reset doc
    const snap = await db.collection("passwordResets").doc(token).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Invalid reset token.");
    }
    const { email } = snap.data();

    // Get uid from email
    const user = await getAuth().getUserByEmail(email);
    const { uid } = user;

    // Hash the new password
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Read existing history, prepend new hash, trim to MAX_HISTORY
    const historyRef  = db.collection("passwordHistory").doc(uid);
    const historySnap = await historyRef.get();
    const existing    = historySnap.exists ? (historySnap.data().hashes ?? []) : [];

    const updatedHashes = [newHash, ...existing].slice(0, MAX_HISTORY);

    await historyRef.set({
      hashes:    updatedHashes,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  saveInitialPasswordHistory
// ════════════════════════════════════════════════════════════════
// Called once after successful signup — seeds password history so
// the signup password is blocked on first password reset attempt

exports.saveInitialPasswordHistory = onCall(
  { cors: true, invoker: ["public"] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { password } = request.data;
    if (!password) {
      throw new HttpsError("invalid-argument", "Password is required.");
    }

    const uid = request.auth.uid;

    // Guard: if history already exists don't overwrite — prevents
    // duplicate calls from re-seeding with a different value
    const historyRef  = db.collection("passwordHistory").doc(uid);
    const historySnap = await historyRef.get();
    if (historySnap.exists) {
      return { success: true, message: "History already seeded." };
    }

    // Hash and store the signup password as the first history entry
    const newHash = await bcrypt.hash(password, SALT_ROUNDS);
    await historyRef.set({
      hashes:    [newHash],
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — addPaymentMethod (supports multiple cards per user)
// ════════════════════════════════════════════════════════════════

exports.addPaymentMethod = onCall(
  { cors: true, invoker: ["public"], secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { paymentMethodId } = request.data;
    if (!paymentMethodId) {
      throw new HttpsError("invalid-argument", "paymentMethodId is required");
    }

    const stripe  = require("stripe")(stripeSecret.value());
    const uid     = request.auth.uid;
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User document not found.");
    }

    const userData = userSnap.data();

    // ── Get or create Stripe customer ────────────────────────────
    let customerId = userData.stripeCustomerId || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    userData.email || request.auth.token.email,
        name:     userData.fullName || "",
        metadata: { firebaseUid: uid },
      });
      customerId = customer.id;
    }

    // ── Attach payment method to Stripe customer ─────────────────
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });

    // ── Retrieve card details ────────────────────────────────────
    const pm    = await stripe.paymentMethods.retrieve(paymentMethodId);
    const last4 = pm.card.last4;
    const brand = pm.card.brand;

    // ── Check if this is the first card → set as default ─────────
    const existingCards = userData.savedCards || [];
    const isFirstCard   = existingCards.length === 0;

    if (isFirstCard) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // ── Save to Firestore ────────────────────────────────────────
    const newCard = { paymentMethodId, last4, brand };

    await userRef.update({
      stripeCustomerId:       customerId,
      savedCards:             FieldValue.arrayUnion(newCard),
      // Only set default if it's the first card
      ...(isFirstCard && { defaultPaymentMethodId: paymentMethodId, cardLast4: last4, cardBrand: brand }),
    });

    return { success: true, last4, brand, isDefault: isFirstCard };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — setDefaultCard
// ════════════════════════════════════════════════════════════════

exports.setDefaultCard = onCall(
  { cors: true, invoker: ["public"], secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { paymentMethodId } = request.data;
    if (!paymentMethodId) {
      throw new HttpsError("invalid-argument", "paymentMethodId is required");
    }

    const stripe   = require("stripe")(stripeSecret.value());
    const uid      = request.auth.uid;
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User document not found.");
    }

    const userData   = userSnap.data();
    const customerId = userData.stripeCustomerId;

    if (!customerId) {
      throw new HttpsError("failed-precondition", "No Stripe customer found.");
    }

    // ── Update default in Stripe ─────────────────────────────────
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // ── Find card details from savedCards ────────────────────────
    const savedCards = userData.savedCards || [];
    const card       = savedCards.find(c => c.paymentMethodId === paymentMethodId);

    // ── Update Firestore ─────────────────────────────────────────
    await userRef.update({
      defaultPaymentMethodId: paymentMethodId,
      cardLast4:  card?.last4 ?? "",
      cardBrand:  card?.brand ?? "",
    });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — removePaymentMethod
// ════════════════════════════════════════════════════════════════

exports.removePaymentMethod = onCall(
  { cors: true, invoker: ["public"], secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { paymentMethodId } = request.data;
    if (!paymentMethodId) {
      throw new HttpsError("invalid-argument", "paymentMethodId is required");
    }

    const stripe   = require("stripe")(stripeSecret.value());
    const uid      = request.auth.uid;
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User document not found.");
    }

    const userData      = userSnap.data();
    const savedCards    = userData.savedCards || [];
    const defaultCardId = userData.defaultPaymentMethodId;

    // ── Detach from Stripe ───────────────────────────────────────
    await stripe.paymentMethods.detach(paymentMethodId);

    // ── Remove from savedCards array ─────────────────────────────
    const updatedCards  = savedCards.filter(c => c.paymentMethodId !== paymentMethodId);

    const updateData = {
      savedCards: updatedCards,
    };

    // ── If removed card was default, set next card as default ────
    if (paymentMethodId === defaultCardId) {
      if (updatedCards.length > 0) {
        const newDefault = updatedCards[0];
        await stripe.customers.update(userData.stripeCustomerId, {
          invoice_settings: { default_payment_method: newDefault.paymentMethodId },
        });
        updateData.defaultPaymentMethodId = newDefault.paymentMethodId;
        updateData.cardLast4              = newDefault.last4;
        updateData.cardBrand              = newDefault.brand;
      } else {
        // No cards left
        updateData.defaultPaymentMethodId = null;
        updateData.cardLast4              = null;
        updateData.cardBrand              = null;
      }
    }

    await userRef.update(updateData);

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — initiateRun
// ════════════════════════════════════════════════════════════════

exports.initiateRun = onCall(
  { cors: true, invoker: ["public"], secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { projectId, docType, existingRunId = null } = request.data;
    if (!projectId || !docType) {
      throw new HttpsError("invalid-argument", "projectId and docType are required");
    }

    const stripe  = require("stripe")(stripeSecret.value());
    const uid     = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    const result = await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "User document not found.");
      }

      const userData        = userSnap.data();
      const freeRuns        = userData.freeRunsRemaining ?? 0;
      const customerId      = userData.stripeCustomerId  || null;
      const paymentMethodId = userData.defaultPaymentMethodId || null;

      if (freeRuns > 0) {
        transaction.update(userRef, {
          freeRunsRemaining: FieldValue.increment(-1),
          totalRunsUsed:     FieldValue.increment(1),
        });
        return { status: "free", freeRunsRemaining: freeRuns - 1 };
      }

      if (!customerId || !paymentMethodId) {
        throw new HttpsError(
          "failed-precondition",
          "No payment method on file. Please add a card in Billing Settings."
        );
      }

      return { status: "charge_needed", customerId, paymentMethodId };
    });

    // ── Free run ─────────────────────────────────────────────────
    if (result.status === "free") {
      const runId = existingRunId
        ? existingRunId
        : (await db.collection("runs").add({
            userId: uid, projectId, docType,
            amount: 0, status: "free",
            createdAt: FieldValue.serverTimestamp(),
          })).id;

      return {
        success: true,
        status: "free",
        freeRunsRemaining: result.freeRunsRemaining,
        runId,
      };
    }

    // ── Paid run ─────────────────────────────────────────────────
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount:         1000,
        currency:       "usd",
        customer:       result.customerId,
        payment_method: result.paymentMethodId,
        confirm:        true,
        off_session:    true,
        description:    `AI Hyperdox run — ${docType}`,
        metadata:       { firebaseUid: uid, projectId, docType },
      });
    } catch (stripeError) {
      throw new HttpsError(
        "failed-precondition",
        stripeError.message || "Payment failed. Please update your card."
      );
    }

    const runId = existingRunId
      ? existingRunId
      : (await db.collection("runs").add({
          userId: uid, projectId, docType,
          amount: 1000, status: "paid",
          stripePaymentIntentId: paymentIntent.id,
          createdAt: FieldValue.serverTimestamp(),
        })).id;

    await userRef.update({ totalRunsUsed: FieldValue.increment(1) });

    return {
      success: true,
      status: "paid",
      paymentIntentId: paymentIntent.id,
      runId,
    };
  }
);

// v13