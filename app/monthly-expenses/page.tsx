'use client';

import { useState, useEffect } from 'react';
import DataTable from '@/components/DataTable';
import { formatCurrency } from '@/lib/utils';

interface MonthlyExpense {
  id: number;
  tenant_name: string;
  property_name: string;
  room_number: string;
  water_dispenser: number;
  internet: number;
  cleaning: number;
  garbage: number;
  helper: number;
  rent: number;
  total: number;
  month: string;
  year: number;
  created_at: string;
}

const fields = [
  { key: 'tenant_name', label: '房客姓名', required: true },
  { key: 'property_name', label: '物件名稱', required: true },
  { key: 'room_number', label: '房號' },
  { key: 'water_dispenser', label: '飲水機', type: 'number' },
  { key: 'internet', label: '網路', type: 'number' },
  { key: 'cleaning', label: '打掃', type: 'number' },
  { key: 'garbage', label: '垃圾', type: 'number' },
  { key: 'helper', label: '小幫手', type: 'number' },
  { key: 'rent', label: '租金', type: 'number', required: true },
  { key: 'month', label: '月份', required: true },
  { key: 'year', label: '年份', type: 'number', required: true },
];

const months = [
  { value: '1月', label: '1月' }, { value: '2月', label: '2月' },
  { value: '3月', label: '3月' }, { value: '4月', label: '4月' },
  { value: '5月', label: '5月' }, { value: '6月', label: '6月' },
  { value: '7月', label: '7月' }, { value: '8月', label: '8月' },
  { value: '9月', label: '9月' }, { value: '10月', label: '10月' },
  { value: '11月', label: '11月' }, { value: '12月', label: '12月' },
];

export default function MonthlyExpensesPage() {
  const [expenses, setExpenses] = useState<MonthlyExpense[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<MonthlyExpense | null>(null);

  useEffect(() => {
    fetchExpenses();
  }, []);

  const fetchExpenses = async () => {
    const res = await fetch('/api/monthly-expenses');
    const data = await res.json();
    setExpenses(data);
  };

  const handleSubmit = async (formData: Record<string, string>) => {
    if (editingExpense) {
      await fetch('/api/monthly-expenses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingExpense.id, ...formData }),
      });
    } else {
      await fetch('/api/monthly-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
    }

    setIsModalOpen(false);
    setEditingExpense(null);
    fetchExpenses();
  };

  const handleEdit = (expense: MonthlyExpense) => {
    setEditingExpense(expense);
    setIsModalOpen(true);
  };

  const handleDelete = async (expense: MonthlyExpense) => {
    if (confirm(`確定要刪除「${expense.tenant_name}」的費用記錄嗎？`)) {
      await fetch(`/api/monthly-expenses?id=${expense.id}`, { method: 'DELETE' });
      fetchExpenses();
    }
  };

  const columns = [
    { key: 'year', label: '年度' },
    { key: 'month', label: '月份' },
    { key: 'tenant_name', label: '房客姓名' },
    { key: 'property_name', label: '物件' },
    { key: 'room_number', label: '房號' },
    { 
      key: 'details', 
      label: '費用明細',
      render: (_: any, row: MonthlyExpense) => (
        <div className="text-xs text-gray-600">
          飲水機:{row.water_dispenser} 網路:{row.internet} 打掃:{row.cleaning}<br/>
          垃圾:{row.garbage} 小幫手:{row.helper} 租金:{row.rent}
        </div>
      )
    },
    { key: 'total', label: '合計', render: (v: number) => <span className="font-semibold text-blue-600">{formatCurrency(v)}</span> },
  ];

  const totalAmount = expenses.reduce((sum, e) => sum + e.total, 0);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">💰 每月費用</h1>
          <p className="text-gray-500 text-sm mt-1">費用總計：{formatCurrency(totalAmount)}</p>
        </div>
        <button
          onClick={() => { setEditingExpense(null); setIsModalOpen(true); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          + 新增費用
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm">
        <DataTable
          columns={columns}
          data={expenses}
          onEdit={handleEdit}
          onDelete={handleDelete}
          emptyMessage="尚無費用記錄"
        />
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold text-gray-800">
                {editingExpense ? '編輯費用' : '新增費用'}
              </h2>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement); const data: Record<string, string> = {}; fd.forEach((v, k) => { data[k] = v.toString(); }); handleSubmit(data); }} className="p-6 space-y-4">
              {fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500">*</span>}
                  </label>
                  {field.key === 'month' ? (
                    <select
                      name={field.key}
                      defaultValue={editingExpense?.month || ''}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      required={field.required}
                    >
                      <option value="">請選擇月份</option>
                      {months.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name={field.key}
                      type={field.type || 'text'}
                      defaultValue={(editingExpense as any)?.[field.key] || (field.type === 'number' ? '0' : '')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      required={field.required}
                    />
                  )}
                </div>
              ))}
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); setEditingExpense(null); }}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                >
                  儲存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
