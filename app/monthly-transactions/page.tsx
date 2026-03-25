'use client';

import { useState, useEffect } from 'react';
import DataTable from '@/components/DataTable';
import { formatCurrency, formatDate } from '@/lib/utils';

interface Transaction {
  id: number;
  type: 'income' | 'expense';
  category: string;
  amount: number;
  description: string;
  transaction_date: string;
  created_at: string;
}

const typeOptions = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
];

const expenseCategories = [
  { value: '維修', label: '維修' },
  { value: '家具電器', label: '家具電器' },
  { value: '獎金', label: '獎金' },
  { value: '退押金', label: '退押金' },
];

const incomeCategories = [
  { value: '押金收入', label: '押金收入' },
];

export default function MonthlyTransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [type, setType] = useState('expense');

  useEffect(() => {
    fetchTransactions();
  }, []);

  const fetchTransactions = async () => {
    const res = await fetch('/api/monthly-transactions');
    const data = await res.json();
    setTransactions(data);
  };

  const handleSubmit = async (formData: Record<string, string>) => {
    if (editingTransaction) {
      await fetch('/api/monthly-transactions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingTransaction.id, ...formData }),
      });
    } else {
      await fetch('/api/monthly-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
    }

    setIsModalOpen(false);
    setEditingTransaction(null);
    fetchTransactions();
  };

  const handleEdit = (transaction: Transaction) => {
    setEditingTransaction(transaction);
    setType(transaction.type);
    setIsModalOpen(true);
  };

  const handleDelete = async (transaction: Transaction) => {
    if (confirm(`確定要刪除這筆${transaction.type === 'income' ? '收入' : '支出'}嗎？`)) {
      await fetch(`/api/monthly-transactions?id=${transaction.id}`, { method: 'DELETE' });
      fetchTransactions();
    }
  };

  const totalIncome = transactions.filter((t) => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = transactions.filter((t) => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);

  const columns = [
    { 
      key: 'type', 
      label: '類型',
      render: (v: string) => (
        <span className={`px-2 py-1 rounded text-sm ${v === 'income' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
          {v === 'income' ? '收入' : '支出'}
        </span>
      )
    },
    { key: 'category', label: '項目' },
    { 
      key: 'amount', 
      label: '金額',
      render: (v: number, row: Transaction) => (
        <span className={row.type === 'income' ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
          {row.type === 'income' ? '+' : '-'}{formatCurrency(v)}
        </span>
      )
    },
    { key: 'description', label: '說明' },
    { key: 'transaction_date', label: '日期', render: (v: string) => formatDate(v) },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📈 每月收支</h1>
          <div className="flex gap-4 mt-2">
            <span className="text-green-600">收入：{formatCurrency(totalIncome)}</span>
            <span className="text-red-600">支出：{formatCurrency(totalExpense)}</span>
            <span className="text-blue-600 font-semibold">結餘：{formatCurrency(totalIncome - totalExpense)}</span>
          </div>
        </div>
        <button
          onClick={() => { setEditingTransaction(null); setType('expense'); setIsModalOpen(true); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          + 新增收支
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm">
        <DataTable
          columns={columns}
          data={transactions}
          onEdit={handleEdit}
          onDelete={handleDelete}
          emptyMessage="尚無收支記錄"
        />
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold text-gray-800">
                {editingTransaction ? '編輯收支' : '新增收支'}
              </h2>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement); const data: Record<string, string> = {}; fd.forEach((v, k) => { data[k] = v.toString(); }); handleSubmit(data); }} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">類型</label>
                <select
                  name="type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {typeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">項目</label>
                <select
                  name="category"
                  defaultValue={editingTransaction?.category || ''}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  required
                >
                  <option value="">請選擇</option>
                  {(type === 'income' ? incomeCategories : expenseCategories).map((cat) => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">金額</label>
                <input
                  name="amount"
                  type="number"
                  defaultValue={editingTransaction?.amount || ''}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">說明</label>
                <input
                  name="description"
                  type="text"
                  defaultValue={editingTransaction?.description || ''}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">日期</label>
                <input
                  name="transaction_date"
                  type="date"
                  defaultValue={editingTransaction?.transaction_date || new Date().toISOString().split('T')[0]}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  required
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); setEditingTransaction(null); }}
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
