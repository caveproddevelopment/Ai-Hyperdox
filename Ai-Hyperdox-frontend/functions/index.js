const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }      = require("firebase-admin/app");
const { getAuth }            = require("firebase-admin/auth");

initializeApp();

const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwYf4q9lVrZsYJjww1YFRdVHaLKzednAB02ftxMYS826BC_CYoA6dyWKqmf0YnKcEk/exec";

async function callGAS(payload) {
  const res = await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type": "text/plain" },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GAS responded with ${res.status}`);
}

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

exports.sendPasswordResetEmail = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const { email, name } = request.data;
    if (!email) throw new HttpsError("invalid-argument", "email is required");

    const link = await getAuth().generatePasswordResetLink(email);
    await callGAS({ type: "reset", email, link, name: name || "" });

    return { success: true };
  }
);
// v3
