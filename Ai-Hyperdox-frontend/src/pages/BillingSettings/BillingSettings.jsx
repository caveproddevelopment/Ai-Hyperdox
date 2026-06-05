import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
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
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import "./BillingSettings.css";

// ── Stripe init ─────────────────────────────────────────────────
const stripeKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY;
const stripePromise = loadStripe(
  stripeKey ?? "pk_test_51TYQUQ1wU394IQ3jlr6UvbCyMR3X6dyUbLPbEZYrjA1ThOfin4Rlqjwqw5khUaf4MgFxGTMRSvvLnqEuUwxs3R4j001AWPyGqL"
);

// ── Add Card Form ───────────────────────────────────────────────
function CardAddForm({ onSuccess, onCancel }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

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
      const addPaymentMethod = httpsCallable(functions, "addPaymentMethod");
      await addPaymentMethod({ paymentMethodId: paymentMethod.id });
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
        <button className="bs-btn bs-btn--ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button className="bs-btn bs-btn--primary" onClick={handleSave} disabled={loading}>
          {loading ? <span className="bs-btn__spinner" /> : "Save Card"}
        </button>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────
export default function BillingSettings() {
  const { currentUser } = useAuth();
  const navigate        = useNavigate();

  const [userData,       setUserData]       = useState(null);
  const [showAddForm,    setShowAddForm]    = useState(false);
  const [successMsg,     setSuccessMsg]     = useState("");
  const [removingId,     setRemovingId]     = useState(null);
  const [settingDefault, setSettingDefault] = useState(null);

  useEffect(() => {
    if (!currentUser) return;
    const unsub = onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
      if (snap.exists()) setUserData(snap.data());
    });
    return unsub;
  }, [currentUser]);

  function showSuccess(msg) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 4000);
  }

  const handleCardSaved = () => {
    setShowAddForm(false);
    showSuccess("✅ Card saved successfully!");
  };

  const handleSetDefault = async (paymentMethodId) => {
    setSettingDefault(paymentMethodId);
    try {
      const setDefaultCard = httpsCallable(functions, "setDefaultCard");
      await setDefaultCard({ paymentMethodId });
      showSuccess("✅ Default card updated!");
    } catch (err) {
      showSuccess("❌ Failed to update default card.");
    } finally {
      setSettingDefault(null);
    }
  };

  const handleRemoveCard = async (paymentMethodId) => {
    if (!window.confirm("Remove this card?")) return;
    setRemovingId(paymentMethodId);
    try {
      const removePaymentMethod = httpsCallable(functions, "removePaymentMethod");
      await removePaymentMethod({ paymentMethodId });
      showSuccess("✅ Card removed successfully!");
    } catch (err) {
      showSuccess("❌ Failed to remove card.");
    } finally {
      setRemovingId(null);
    }
  };

  const freeRuns      = userData?.freeRunsRemaining ?? 0;
  const savedCards    = userData?.savedCards ?? [];
  const defaultCardId = userData?.defaultPaymentMethodId ?? null;

  const pricingRows = [
    { label: "Goals & Scope", price: "$10 per run" },
    { label: "Project Plan",  price: "$10 per run" },
    { label: "Execution",     price: "$10 per run" },
  ];

  return (
    <div className="bs-page">
      <div className="bs-bg-grid" aria-hidden="true" />

      {/* ── Logo ── */}
      <Link to="/dashboard" className="bs-logo">
        <img src={logo} alt="AI Hyperdox" />
      </Link>

      <div className="bs-container">

        {/* Header */}
        <div className="bs-header">
          <div className="bs-header__eyebrow">Account</div>
          <h1 className="bs-header__title">Billing Settings</h1>
          <div className="bs-header__line" />
        </div>

        {/* Success / Error banner */}
        {successMsg && (
          <div className={`bs-banner ${successMsg.startsWith("❌") ? "bs-banner--error" : "bs-banner--success"}`}>
            {successMsg}
          </div>
        )}

        {/* Free Runs */}
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

        {/* Payment Methods Section */}
        <div className="bs-section">
          <div className="bs-section__header">
            <p className="bs-section__title">Payment Methods</p>
            {!showAddForm && (
              <button className="bs-btn bs-btn--link" onClick={() => setShowAddForm(true)}>
                + Add Card
              </button>
            )}
          </div>

          {/* Add Card Form */}
          {showAddForm && (
            <div className="bs-card bs-card--form">
              <Elements stripe={stripePromise}>
                <CardAddForm
                  onSuccess={handleCardSaved}
                  onCancel={() => setShowAddForm(false)}
                />
              </Elements>
            </div>
          )}

          {/* Cards List */}
          {savedCards.length === 0 && !showAddForm ? (
            <div className="bs-card">
              <div className="bs-card__body">
                <p className="bs-card__value bs-card__value--empty">No cards on file</p>
              </div>
            </div>
          ) : (
            savedCards.map((card) => (
              <div
                key={card.paymentMethodId}
                className={`bs-card bs-saved-card ${card.paymentMethodId === defaultCardId ? "bs-saved-card--default" : ""}`}
              >
                <div className="bs-card__icon">💳</div>
                <div className="bs-card__body">
                  <p className="bs-card__label">
                    {card.brand?.toUpperCase() ?? "Card"}
                    {card.paymentMethodId === defaultCardId && (
                      <span className="bs-default-badge">Default</span>
                    )}
                  </p>
                  <p className="bs-card__value">
                    <span className="bs-card-dots">•••• •••• ••••</span>
                    <span className="bs-highlight"> {card.last4}</span>
                  </p>
                </div>
                <div className="bs-card__actions">
                  {card.paymentMethodId !== defaultCardId && (
                    <button
                      className="bs-btn bs-btn--ghost bs-btn--sm"
                      onClick={() => handleSetDefault(card.paymentMethodId)}
                      disabled={settingDefault === card.paymentMethodId}
                    >
                      {settingDefault === card.paymentMethodId ? "..." : "Set Default"}
                    </button>
                  )}
                  <button
                    className="bs-btn bs-btn--danger bs-btn--sm"
                    onClick={() => handleRemoveCard(card.paymentMethodId)}
                    disabled={removingId === card.paymentMethodId}
                  >
                    {removingId === card.paymentMethodId ? "..." : "Remove"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pricing */}
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
            Free runs are used first. Once exhausted, each run is charged to your default card.
          </p>
        </div>

        <button className="bs-back-link" onClick={() => navigate("/profile")}>
          ← Return To Your Profile Settings
        </button>

      </div>
    </div>
  );
}