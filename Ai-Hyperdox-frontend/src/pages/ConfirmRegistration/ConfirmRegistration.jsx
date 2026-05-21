// src/pages/ConfirmRegistration/ConfirmRegistration.jsx
import { Link } from "react-router-dom";
import logo from "../../assets/AI Hyperdox Logo Square V2.png";
import "./ConfirmRegistration.css";

export default function ConfirmRegistration() {
  return (
    <div className="confirm-page">

      {/* Logo top-left */}
      <div className="confirm-logo">
        <img src={logo} alt="AI Hyperdox" />
      </div>

      <div className="confirm-content">
        <p className="confirm-sweet">Sweet!</p>
        <p className="confirm-msg">
          AI Hyperdox sent you an email for verification.
          <br />
          Please take care of that email.
        </p>

        {/* ── Sign In prompt ── */}
        <div className="confirm-signin-prompt">
          <p>Once you've verified your email, you're ready to launch:</p>
          <Link to="/signin" className="confirm-signin-btn">
            Sign In to Your Account
          </Link>
        </div>

        <p className="confirm-meanwhile">In the meantime you can</p>

        <button className="confirm-see-how">
          See how AI Hyperdox Works ___
        </button>

        <p className="confirm-or">or</p>

        <p className="confirm-explore-label">Look at the Agents and examples</p>

        <div className="confirm-links">
          <Link to="/agents/goals-scope" className="confirm-link">
            Goals and Scope Hyperdox
          </Link>
          <Link to="/agents/project-plan" className="confirm-link">
            Project Plan Hyperdox
          </Link>
          <Link to="/agents/execution" className="confirm-link">
            Execution Hyperdox
          </Link>
        </div>
      </div>

    </div>
  );
}