// src/pages/Home/Home.jsx
import { useNavigate } from 'react-router-dom';
import Navbar from '../../components/Navbar/Navbar';
import braindump from '../../assets/Braindump V2.png';
import './Home.css';

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="app">

      {/* NAVBAR — shared component */}
      <Navbar />

      {/* HERO */}
      <main className="hero">

        {/* LEFT */}
        <div className="hero-left">
          <img
            src={braindump}
            alt="AI Hyperdox Features"
            className="hero-left-img"
          />
        </div>

        {/* RIGHT */}
        <div className="hero-right">

          {/* WHAT BOX */}
          <div className="what-box">
            <div className="what-title">What it does</div>

            <ul className="what-list">
              <li className="what-item-1">Our cutting edge Agents want your input. We NEED it!</li>
              <li className="what-item-2">Thoughts. Notes. Emails. You feed it. We devour it.</li>
              <li className="what-item-3">
                The key information is extracted and Ai Hyperdox
                <br />generates sweet, sweet document gold.
              </li>
            </ul>
          </div>

          {/* OUTCOME LIST */}
          <div className="outcome-list">
            <p className="strikethrough">Missed Steps</p>
            <p className="strikethrough">Document Writing Nightmares</p>
            <p className="underline-red">Procrastination Monster</p>
            <p className="positive">Quality</p>
            <p className="positive">Confidence</p>
            <p className="positive">A Better World For All Mankind</p>
          </div>

          {/* CTA — now part of hero-right, left-aligned under outcome list */}
          <div className="cta-section">
            <button className="cta-btn" onClick={() => navigate('/signup')}>
              GET STARTED TODAY FOR FREE
            </button>

            <p className="cta-sub">
              Your First 3 Full Document<br />
              Runs Are Free
            </p>
          </div>

        </div>

      </main>

    </div>
  );
}