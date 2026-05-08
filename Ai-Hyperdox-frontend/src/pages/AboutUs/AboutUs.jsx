// src/pages/AboutUs/AboutUs.jsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../../components/Navbar/Navbar';
import './AboutUs.css';

export default function AboutUs() {
  const navigate = useNavigate();

  return (
    <div className="about-page">
      <Navbar />

      <div className="about-container">
        <h1 className="about-title">About AI Hyperdox</h1>
        <p className="about-body">
          Text about AI Hyperdox and Caveman Productions
        </p>
      </div>

      <div className="about-cta">
        <button className="about-cta-btn" onClick={() => navigate('/signup')}>
          GET STARTED TODAY FOR FREE
        </button>
      </div>
    </div>
  );
}