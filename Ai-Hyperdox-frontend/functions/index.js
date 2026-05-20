const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }      = require("firebase-admin/app");
const { getAuth }            = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { defineSecret }       = require("firebase-functions/params");

initializeApp();

const db = getFirestore();

const stripeSecret = defineSecret("STRIPE_SECRET_KEY");

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
//  sendVerificationEmail — unchanged, sends Firebase link directly
// ════════════════════════════════════════════════════════════════

exports.sendVerificationEmail = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const { uid, name } = request.data;
    if (!uid) throw new HttpsError("invalid-argument", "uid is required");

    const user = await getAuth().getUser(uid);
    if (user.emailVerified) return { success: true, message: "Already verified" };

    const link = await getAuth().generateEmailVerificationLink(user.email);
    await callGAS({ type: "verification", email: user.email, link, name: name || "" });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  sendPasswordResetEmail — sends custom 5-min token link
// ════════════════════════════════════════════════════════════════

exports.sendPasswordResetEmail = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const { email, name } = request.data;
    if (!email) throw new HttpsError("invalid-argument", "email is required");

    try {
      // Generate the real Firebase reset link
      const firebaseLink = await getAuth().generatePasswordResetLink(email);

      // Store token with 5-min expiry in Firestore
      const token = generateToken();
      await db.collection("passwordResets").doc(token).set({
        email,
        link:      firebaseLink,
        createdAt: Date.now(),
        expiresAt: Date.now() + EXPIRY_MS,
        used:      false,
      });

      // Send custom link — NOT the Firebase link directly
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

// ════════════════════════════════════════════════════════════════
//  validateResetToken — called by ResetPassword page on load
// ════════════════════════════════════════════════════════════════

exports.validateResetToken = onCall(
  { cors: true, invoker: "public" },
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

    // Mark as used so it cannot be reused
    await db.collection("passwordResets").doc(token).update({ used: true });

    return { link: data.link, email: data.email };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — savePaymentMethod
// ════════════════════════════════════════════════════════════════

exports.savePaymentMethod = onCall(
  { cors: true, invoker: "public", secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { paymentMethodId } = request.data;
    if (!paymentMethodId) {
      throw new HttpsError("invalid-argument", "paymentMethodId is required");
    }

    const stripe = require("stripe")(stripeSecret.value());
    const uid    = request.auth.uid;

    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User document not found.");
    }
    const userData = userSnap.data();

    let customerId = userData.stripeCustomerId || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    userData.email || request.auth.token.email,
        name:     userData.fullName || "",
        metadata: { firebaseUid: uid },
      });
      customerId = customer.id;
    }

    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const pm    = await stripe.paymentMethods.retrieve(paymentMethodId);
    const last4 = pm.card.last4;
    const brand = pm.card.brand;

    await userRef.update({
      stripeCustomerId:       customerId,
      defaultPaymentMethodId: paymentMethodId,
      cardLast4:              last4,
      cardBrand:              brand,
    });

    return { success: true, last4, brand };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — initiateRun
// ════════════════════════════════════════════════════════════════

exports.initiateRun = onCall(
  { cors: true, invoker: "public", secrets: [stripeSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { projectId, docType } = request.data;
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

    if (result.status === "free") {
      await db.collection("runs").add({
        userId: uid, projectId, docType,
        amount: 0, status: "free",
        createdAt: FieldValue.serverTimestamp(),
      });
      return { success: true, status: "free", freeRunsRemaining: result.freeRunsRemaining };
    }

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

    await db.collection("runs").add({
      userId: uid, projectId, docType,
      amount: 1000, status: "paid",
      stripePaymentIntentId: paymentIntent.id,
      createdAt: FieldValue.serverTimestamp(),
    });

    await userRef.update({ totalRunsUsed: FieldValue.increment(1) });

    return { success: true, status: "paid", paymentIntentId: paymentIntent.id };
  }
);

// v6