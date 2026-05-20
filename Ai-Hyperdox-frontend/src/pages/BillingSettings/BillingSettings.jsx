import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { db, functions } from "../../firebase";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import "./BillingSettings.css";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

function CardUpdateForm({ onSuccess, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!stripe || !elements) return;
    setLoading(true);
    setError("");

    const cardEl = elements.getElement(CardElement);
    const { paymentMethod, error: stripeError } =
      await stripe.createPaymentMethod({ type: "card", card: cardEl });

    if (stripeError) {
      setError(stripeError.message);
      setLoading(false);
      return;
    }

    try {
      const savePaymentMethod = httpsCallable(functions, "savePaymentMethod");
      await savePaymentMethod({ paymentMethodId: paymentMethod.id });
      onSuccess();
    } catch (err) {
      setError(err.message || "Failed to save card. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bs-card-form">
      <p className="bs-card-form__label">Enter new card details</p>
      <div className="bs-card-element-wrapper">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: "15px",
                color: "#e0f7fa",
                fontFamily: "'Courier New', monospace",
                "::placeholder": { color: "#4a6572" },
              },
              invalid: { color: "#ff6b6b" },
            },
          }}
        />
      </div>
      {error && <p className="bs-card-form__error">{error}</p>}
      <div className="bs-card-form__actions">
        <button
          className="bs-btn bs-btn--ghost"
          onClick={onCancel}
          disabled={loading}
        >
          Cancel
        </button>
        <button
          className="bs-btn bs-btn--primary"
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? (
            <span className="bs-btn__spinner" />
          ) : (
            "Save Card"
          )}
        </button>
      </div>
    </div>
  );
}

export default function BillingSettings() {
  const { currentUser } = useAuth();
  const navigate = useNavigate();

  const [userData, setUserData] = useState(null);
  const [showCardForm, setShowCardForm] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (!currentUser) return;
    const unsub = onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
      if (snap.exists()) setUserData(snap.data());
    });
    return unsub;
  }, [currentUser]);

  const handleCardSaved = () => {
    setShowCardForm(false);
    setSuccessMsg("Card updated successfully!");
    setTimeout(() => setSuccessMsg(""), 4000);
  };

  const freeRuns = userData?.freeRunsRemaining ?? 0;
  const cardLast4 = userData?.cardLast4 ?? null;

  const pricingRows = [
    { label: "Goals & Scope", price: "$10 per run" },
    { label: "Project Plan", price: "$10 per run" },
    { label: "Execution", price: "$10 per run" },
  ];

  return (
    <div className="bs-page">
      <div className="bs-bg-grid" aria-hidden="true" />

      <div className="bs-container">
        <div className="bs-header">
          <div className="bs-header__eyebrow">Account</div>
          <h1 className="bs-header__title">Billing Settings</h1>
          <div className="bs-header__line" />
        </div>

        {successMsg && (
          <div className="bs-banner bs-banner--success">{successMsg}</div>
        )}

        <div className="bs-card">
          <div className="bs-card__icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="bs-card__body">
            <p className="bs-card__label">Free Runs Remaining</p>
            <p className="bs-card__value">
              <span className="bs-highlight">{freeRuns}</span>
              <span className="bs-card__sub"> runs left</span>
            </p>
          </div>
          <div className={`bs-runs-badge ${freeRuns === 0 ? "bs-runs-badge--empty" : ""}`}>
            {freeRuns > 0 ? "Active" : "Exhausted"}
          </div>
        </div>

        <div className="bs-card">
          <div className="bs-card__icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
              <line x1="1" y1="10" x2="23" y2="10" />
            </svg>
          </div>
          <div className="bs-card__body">
            <p className="bs-card__label">Payment Method</p>
            {cardLast4 ? (
              <p className="bs-card__value">
                <span className="bs-card-dots">•••• •••• ••••</span>
                <span className="bs-highlight"> {cardLast4}</span>
              </p>
            ) : (
              <p className="bs-card__value bs-card__value--empty">
                No card on file
              </p>
            )}
          </div>
          {!showCardForm && (
            <button
              className="bs-btn bs-btn--link"
              onClick={() => setShowCardForm(true)}
            >
              {cardLast4 ? "Change" : "Add Card"}
            </button>
          )}
        </div>

        {showCardForm && (
          <div className="bs-card bs-card--form">
            <Elements stripe={stripePromise}>
              <CardUpdateForm
                onSuccess={handleCardSaved}
                onCancel={() => setShowCardForm(false)}
              />
            </Elements>
          </div>
        )}

        <div className="bs-section">
          <p className="bs-section__title">Run Pricing</p>
          <div className="bs-pricing-table">
            {pricingRows.map((row, i) => (
              <div className="bs-pricing-row" key={i}>
                <span className="bs-pricing-row__label">{row.label}</span>
                <span className="bs-pricing-row__arrow">→</span>
                <span className="bs-pricing-row__price">{row.price}</span>
              </div>
            ))}
          </div>
          <p className="bs-pricing-note">
            Free runs are used first. Once exhausted, each run is charged to your stored card.
          </p>
        </div>

        <button
          className="bs-back-link"
          onClick={() => navigate("/profile")}
        >
          ← Return To Your Profile Settings
        </button>
      </div>
    </div>
  );
}
