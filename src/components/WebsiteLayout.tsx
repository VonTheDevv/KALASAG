import { useState, useRef, useEffect, useId } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface WebsiteLayoutProps {
  children: React.ReactNode;
}

export default function WebsiteLayout({ children }: WebsiteLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const pageScrollRef = useRef<HTMLDivElement>(null);
  const profileMenuId = useId();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setProfileMenuOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileMenuOpen(false);
    };
    if (profileMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    setMobileMenuOpen(false);
    const frame = window.requestAnimationFrame(() => {
      if (location.pathname === '/' && location.hash === '#about') {
        document.getElementById('about')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
      } else {
        pageScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.pathname]);

  const navLinks = [
    { name: 'Home', path: '/' },
    { name: 'Features', path: '/features' },
    { name: 'Downloads', path: '/downloads' },
    { name: 'Blog', path: '/blog' },
  ];

  const isNavLinkActive = (path: string) => {
    if (path === '/#about') return location.pathname === '/' && location.hash === '#about';
    if (path === '/') return location.pathname === '/' && location.hash !== '#about';
    return location.pathname === path;
  };

  const handleNavClick = (event: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    setMobileMenuOpen(false);
    if (path === '/' && location.pathname === '/' && !location.hash) {
      event.preventDefault();
      pageScrollRef.current?.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      return;
    }
    if (path === '/#about' && location.pathname === '/' && location.hash === '#about') {
      event.preventDefault();
      document.getElementById('about')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  };

  const handleLogout = async () => {
    await signOut();
    setProfileMenuOpen(false);
    setMobileMenuOpen(false);
    navigate('/');
  };

  const userInitial = user?.email?.[0]?.toUpperCase() || '?';

  const ProfileDropdown = () => (
    <div className="relative" ref={profileMenuRef}>
      <button type="button" onClick={() => setProfileMenuOpen(o => !o)} aria-label="Open account menu" aria-haspopup="menu" aria-expanded={profileMenuOpen} aria-controls={profileMenuId} className="flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-full border border-[#1e293b] hover:border-[#3b82f6]/40 bg-[#0f172a] transition-all duration-200">
        <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">{userInitial}</div>
        <ChevronDown size={12} className={`text-[#94a3b8] transition-transform duration-200 ${profileMenuOpen ? 'rotate-180' : ''}`} />
      </button>
      {profileMenuOpen && (
        <div id={profileMenuId} role="menu" data-state="open" data-side="bottom" className="custom-dropdown-content absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl !bg-[#0f172a] shadow-2xl shadow-black/60">
          <div className="px-4 py-3 border-b border-[#1e293b]/60">
            <p className="text-xs font-semibold text-white truncate">{user?.email}</p>
            <p className="text-[10px] text-[#64748b] mt-0.5">Signed in</p>
          </div>
          <div className="py-1">
            <button type="button" role="menuitem" onClick={handleLogout} className="custom-dropdown-item w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors text-left">
              <LogOut size={15} />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div ref={pageScrollRef} data-theme="dark" className="website-scroll-shell flex h-[100dvh] min-h-[100dvh] flex-col justify-between overflow-x-hidden overflow-y-auto scroll-smooth bg-[#020617] font-['Inter'] text-[15px] text-[#cbd5e1] antialiased selection:bg-[#d8e2ff] selection:text-[#001a42]">
      <div className="flex-grow">
        <nav className="website-nav sticky top-0 z-50 w-full animate-fade-in border-b border-[#1e293b]/60 bg-[#020617]/90 shadow-sm backdrop-blur-md transition-all duration-300">
          <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6">
            <Link to="/" className="flex items-center gap-2.5 group">
              <img alt="KALASAG Logo" className="h-7 w-7 rounded-md object-contain transition-transform duration-500 group-hover:rotate-[360deg]" src="/kalasag-logo.png" />
              <div className="font-['Hanken_Grotesk'] text-[19px] font-extrabold tracking-[0] text-white sm:text-[20px]">KALASAG</div>
            </Link>
            <div className="hidden items-center gap-1 lg:flex xl:gap-2">
              {navLinks.map((link) => <Link key={link.path} to={link.path} onClick={event => handleNavClick(event, link.path)} className={`rounded-lg px-3 py-1.5 font-['Hanken_Grotesk'] text-[13px] font-semibold tracking-[0] transition-all duration-200 ${isNavLinkActive(link.path) ? 'bg-[#1e293b] text-white' : 'text-[#94a3b8] hover:bg-[#1e293b]/50 hover:text-white'}`}>{link.name}</Link>)}
            </div>
            <div className="hidden items-center gap-2 lg:flex xl:gap-3">
              {user ? <ProfileDropdown /> : <>
                <button onClick={() => navigate('/login')} className="min-h-11 px-3 font-['JetBrains_Mono'] text-[12px] font-medium text-[#94a3b8] transition-colors hover:text-white">Login</button>
                <button onClick={() => navigate('/signup')} className="min-h-11 rounded-lg border border-blue-500/20 bg-blue-600 px-4 font-['JetBrains_Mono'] text-[12px] font-semibold text-white shadow-md transition-all duration-150 hover:bg-blue-500 hover:shadow-blue-500/10 active:scale-[0.97]">Signup</button>
              </>}
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="grid h-11 w-11 place-items-center rounded-lg text-white transition-colors hover:bg-[#1e293b]/50 lg:hidden"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              aria-controls="website-mobile-navigation"
            >
              {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
          </div>
          {mobileMenuOpen && (
            <div id="website-mobile-navigation" className="website-mobile-menu space-y-2 overflow-y-auto border-t border-[#1e293b]/60 bg-[#020617]/98 px-4 py-4 animate-fade-in sm:px-6 lg:hidden">
              {navLinks.map((link) => <Link key={link.path} to={link.path} onClick={event => handleNavClick(event, link.path)} className={`flex min-h-11 items-center rounded-lg px-3 font-['Hanken_Grotesk'] text-[14px] font-semibold tracking-[0] ${isNavLinkActive(link.path) ? 'bg-[#1e293b] text-white' : 'text-[#94a3b8] hover:text-white'}`}>{link.name}</Link>)}
              <div className="pt-4 border-t border-[#1e293b]/40 flex flex-col gap-2">
                {user ? <>
                  <div className="flex items-center gap-2.5 px-2 py-1 mb-1"><div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold shrink-0">{userInitial}</div><span className="text-[13px] text-white font-medium truncate">{user.email}</span></div>
                  <button onClick={handleLogout} className="min-h-11 w-full px-2 text-left font-['JetBrains_Mono'] text-[13px] font-medium text-red-400 hover:text-red-300">Logout</button>
                </> : <>
                  <button onClick={() => { navigate('/login'); setMobileMenuOpen(false); }} className="min-h-11 w-full text-center font-['JetBrains_Mono'] text-[13px] font-medium text-[#94a3b8] hover:text-white">Login</button>
                  <button onClick={() => { navigate('/signup'); setMobileMenuOpen(false); }} className="min-h-11 w-full rounded-lg bg-blue-600 text-center font-['JetBrains_Mono'] text-[13px] font-semibold text-white hover:bg-blue-500">Signup</button>
                </>}
              </div>
            </div>
          )}
        </nav>
        <main>{children}</main>
      </div>
      <footer className="website-footer mx-auto mt-12 flex w-full max-w-[1200px] flex-col items-start justify-between gap-4 border-t border-[#1e293b]/40 bg-[#020617] px-4 py-6 sm:mt-16 sm:px-6 md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          <img alt="KALASAG Logo" className="h-6 w-6 rounded-md object-contain" src="/kalasag-logo.png" />
          <div className="font-['Hanken_Grotesk'] text-[18px] font-bold text-white">KALASAG</div>
        </div>
        <div className="font-['Inter'] text-[13px] leading-5 text-[#64748b] sm:text-[13.5px]">© 2026 KALASAG Systems Inc. Precision. Reliability. Sophistication.</div>
      </footer>
    </div>
  );
}
