'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

const menuItems = [
  { href: '/dashboard', label: '儀表板', icon: '📊' },
  { href: '/landlord-contracts', label: '房東合約', icon: '📝' },
  { href: '/tenant-contracts', label: '房客合約', icon: '👤' },
  { href: '/monthly-expenses', label: '每月費用', icon: '💰' },
  { href: '/monthly-transactions', label: '每月收支', icon: '📈' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="w-64 bg-gray-900 text-white min-h-screen p-4 flex flex-col">
      <div className="mb-8">
        <h1 className="text-xl font-bold text-blue-400">🏠 房租管理系統</h1>
      </div>

      <nav className="flex-1 space-y-2">
        {menuItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg transition ${
              pathname === item.href
                ? 'bg-blue-600 text-white'
                : 'text-gray-300 hover:bg-gray-800'
            }`}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <button
        onClick={() => signOut({ callbackUrl: '/' })}
        className="mt-4 w-full bg-red-600 text-white py-3 rounded-lg font-medium hover:bg-red-700 transition"
      >
        登出
      </button>
    </div>
  );
}
