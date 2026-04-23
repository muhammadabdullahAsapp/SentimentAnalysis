'use client';

import EmotionTest from '../components/EmotionTest';
import ProtectedRoute from '../components/ProtectedRoute';
import { useAuth } from '../context/AuthContext';
import { LogOut } from 'lucide-react';

export default function Home() {
  const { logout, user } = useAuth();

  return (
    <ProtectedRoute>
      <main className="min-h-screen bg-[#0a0a0a] text-white">
        {/* Navigation / Header */}
        <nav className="sticky top-0 z-50 backdrop-blur-md bg-black/50 border-b border-white/5 px-6 py-4">
          <div className="max-w-7xl mx-auto flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600"></div>
              <span className="font-bold tracking-tight text-xl">Expression Detector</span>
            </div>
            
            <div className="flex items-center gap-6">
              <div className="hidden sm:block text-right">
                <p className="text-xs text-gray-500 uppercase font-semibold tracking-wider">Logged in as</p>
                <p className="text-sm font-medium text-gray-300">{user?.email}</p>
              </div>
              <button 
                onClick={logout}
                className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-4 py-2 text-sm font-medium transition-all active:scale-95"
              >
                <LogOut size={16} className="text-purple-400" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </nav>

        {/* Content */}
        <div className="max-w-7xl mx-auto p-6">
          <EmotionTest />
        </div>
      </main>
    </ProtectedRoute>
  );
}
