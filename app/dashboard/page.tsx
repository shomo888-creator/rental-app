import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import db from '@/lib/db';
import Link from 'next/link';
import { formatCurrency, isExpiringSoon } from '@/lib/utils';

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  const landlordContracts = db.prepare('SELECT * FROM landlord_contracts').all() as any[];
  const tenantContracts = db.prepare('SELECT * FROM tenant_contracts').all() as any[];
  const monthlyExpenses = db.prepare('SELECT * FROM monthly_expenses').all() as any[];
  const transactions = db.prepare('SELECT * FROM monthly_transactions').all() as any[];

  // Calculate stats
  const totalRent = landlordContracts.reduce((sum: number, c: any) => sum + (c.rent || 0), 0);
  const expiringLandlord = landlordContracts.filter((c: any) => isExpiringSoon(c.end_date)).length;
  const expiringTenant = tenantContracts.filter((c: any) => isExpiringSoon(c.end_date)).length;

  // Monthly transactions
  const income = transactions.filter((t: any) => t.type === 'income').reduce((sum: number, t: any) => sum + t.amount, 0);
  const expense = transactions.filter((t: any) => t.type === 'expense').reduce((sum: number, t: any) => sum + t.amount, 0);

  const cards = [
    { title: '房源總數', value: landlordContracts.length, icon: '🏠', color: 'bg-blue-500' },
    { title: '房客總數', value: tenantContracts.length, icon: '👤', color: 'bg-green-500' },
    { title: '月租金收入', value: formatCurrency(totalRent), icon: '💵', color: 'bg-purple-500' },
    { title: '即將到期合約', value: expiringLandlord + expiringTenant, icon: '⚠️', color: 'bg-orange-500' },
  ];

  const recentExpiring = [
    ...landlordContracts.filter((c: any) => isExpiringSoon(c.end_date)).map((c: any) => ({ ...c, type: '房東' })),
    ...tenantContracts.filter((c: any) => isExpiringSoon(c.end_date)).map((c: any) => ({ ...c, type: '房客' })),
  ].sort((a, b) => new Date(a.end_date).getTime() - new Date(b.end_date).getTime()).slice(0, 5);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">歡迎回來，{session?.user?.name}！</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {cards.map((card) => (
          <div key={card.title} className="bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center gap-4">
              <div className={`${card.color} w-12 h-12 rounded-lg flex items-center justify-center text-2xl`}>
                {card.icon}
              </div>
              <div>
                <p className="text-gray-500 text-sm">{card.title}</p>
                <p className="text-2xl font-bold text-gray-800">{card.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">📈 本月收支概況</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">收入</span>
              <span className="text-green-600 font-semibold">{formatCurrency(income)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">支出</span>
              <span className="text-red-600 font-semibold">{formatCurrency(expense)}</span>
            </div>
            <hr />
            <div className="flex justify-between items-center">
              <span className="text-gray-800 font-medium">結餘</span>
              <span className={`font-bold ${income - expense >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(income - expense)}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">⚠️ 即將到期合約</h2>
          {recentExpiring.length === 0 ? (
            <p className="text-gray-500 text-center py-8">沒有即將到期的合約 🎉</p>
          ) : (
            <div className="space-y-3">
              {recentExpiring.map((item: any) => (
                <Link
                  key={item.id}
                  href={item.type === '房東' ? '/landlord-contracts' : '/tenant-contracts'}
                  className="flex justify-between items-center p-3 bg-orange-50 rounded-lg hover:bg-orange-100 transition"
                >
                  <div>
                    <p className="font-medium text-gray-800">
                      {item.type === '房東' ? item.property_name : item.tenant_name}
                    </p>
                    <p className="text-sm text-gray-500">{item.type === '房東' ? '房東合約' : '房客合約'}</p>
                  </div>
                  <span className="text-orange-600 text-sm font-medium">
                    {new Date(item.end_date).toLocaleDateString('zh-TW')}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
