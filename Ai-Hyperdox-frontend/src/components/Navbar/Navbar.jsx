// src/components/Navbar/Navbar.jsx
import { useNavigate, useLocation } from 'react-router-dom';  // ← add useLocation
import logo from '../../assets/AI Hyperdox Logo Square V2.png';
import './Navbar.css';

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();  // ← add this

  // Helper: returns 'nav-link-active' if current path matches
  const activeClass = (path) => location.pathname === path ? 'nav-link-active' : '';

  return (
    <nav className="navbar">
      <div className="nav-logo">
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