// src/pages/ContactUs/ContactUs.jsx
import React, { useState } from 'react';
import Navbar from '../../components/Navbar/Navbar';  // ← add
import './ContactUs.css';

export default function ContactUs() {
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Full name is required.';
    if (!form.email.trim()) {
      errs.email = 'Email address is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errs.email = 'Please enter a valid email address.';
    }
    if (!form.message.trim()) errs.message = 'Message cannot be empty.';
    return errs;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setSubmitted(true);
    }, 1200);
  };

  return (
    <div className="auth-page">
      <Navbar />  {/* ← replaces the old auth-logo div */}

      <div className="auth-card">
        <h1 className="auth-headline">What's Up?</h1>

        {submitted ? (
          <div className="contact-success">
            <span className="contact-success-icon">✓</span>
            <p>Your message has been sent! We'll get back to you soon.</p>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <div className="auth-field">
              <label htmlFor="name">Your Full Name:</label>
              <div className="input-wrapper">
                <input
                  id="name" name="name" type="text" autoComplete="name"
                  value={form.name} onChange={handleChange}
                  className={errors.name ? 'input-error' : ''}
                />
                {errors.name && <span className="field-error">{errors.name}</span>}
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="email">Your Email Address:</label>
              <div className="input-wrapper">
                <input
                  id="email" name="email" type="email" autoComplete="email"
                  value={form.email} onChange={handleChange}
                  className={errors.email ? 'input-error' : ''}
                />
                {errors.email && <span className="field-error">{errors.email}</span>}
              </div>
            </div>

            <div className="auth-field auth-field--textarea">
              <label htmlFor="message">Your Message:</label>
              <div className="input-wrapper">
                <textarea
                  id="message" name="message" rows={6}
                  value={form.message} onChange={handleChange}
                  className={errors.message ? 'input-error' : ''}
                />
                {errors.message && <span className="field-error">{errors.message}</span>}
              </div>
            </div>

            <div className="auth-actions">
              <button type="submit" className="auth-btn-primary" disabled={loading}>
                {loading ? 'Sending…' : 'Submit Message'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}