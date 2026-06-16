// src/components/Navbar/Navbar.jsx
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import './Navbar.css';

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser } = useAuth();

  const activeClass = (path) => location.pathname === path ? 'nav-link-active' : '';

  return (
    <nav className="navbar">

      {/* ── Logo → dashboard if signed in, homepage if not ── */}
      <div
        className="nav-logo"
        onClick={() => navigate(currentUser ? '/dashboard' : '/')}
        style={{ cursor: 'pointer' }}
      >
        <img src={logo} alt="AI Hyperdox Logo" className="logo-img" />
      </div>

      <div className="nav-links">
        <a href="#" className={activeClass('/products')}>Products <span className="arrow">▾</span></a>
        <a href="#" className={activeClass('/how-it-works')}>How It Works</a>
        <a href="#" className={activeClass('/pricing')}>Pricing</a>
        <a onClick={() => navigate('/contact')} className={activeClass('/contact')} style={{ cursor: 'pointer' }}>Contact Us</a>
        <a onClick={() => navigate('/about')} className={activeClass('/about')} style={{ cursor: 'pointer' }}>About Us</a>
      </div>

      <div className="nav-auth">
        <button className={`sign-in nav-btn-link ${activeClass('/signin')}`} onClick={() => navigate('/signin')}>
          Sign In
        </button>
        <span className="auth-or">or</span>
        <button className={`sign-up nav-btn-link ${activeClass('/signup')}`} onClick={() => navigate('/signup')}>
          Sign Up (For Free)
        </button>
      </div>

    </nav>
  );
}