'use client';

import { useState, useEffect } from 'react';
import DataTable from '@/components/DataTable';
import FormModal from '@/components/FormModal';
import { formatDate, formatCurrency, isExpiringSoon, getDaysUntilExpiry } from '@/lib/utils';

interface LandlordContract {
  id: number;
  property_name: string;
  rent: number;
  start_date: string;
  end_date: string;
  address: string;
  pdf_path: string | null;
  created_at: string;
}

const fields: Array<{key: string; label: string; type?: string; required?: boolean}> = [
  { key: 'property_name', label: '物件名稱', required: true },
  { key: 'rent', label: '租金', type: 'number', required: true },
  { key: 'start_date', label: '起租日', type: 'date', required: true },
  { key: 'end_date', label: '到期日', type: 'date', required: true },
  { key: 'address', label: '地址', required: true },
];

export default function LandlordContractsPage() {
  const [contracts, setContracts] = useState<LandlordContract[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<LandlordContract | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);

  useEffect(() => {
    fetchContracts();
  }, []);

  const fetchContracts = async () => {
    const res = await fetch('/api/landlord-contracts');
    const data = await res.json();
    setContracts(data);
  };

  const handleSubmit = async (formData: Record<string, string>) => {
    let pdfPath = editingContract?.pdf_path || '';

    if (pdfFile) {
      const uploadForm = new FormData();
      uploadForm.append('file', pdfFile);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: uploadForm });
      const uploadData = await uploadRes.json();
      pdfPath = uploadData.path;
    }

    const payload = { ...formData, pdf_path: pdfPath };

    if (editingContract) {
      await fetch('/api/landlord-contracts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingContract.id, ...payload }),
      });
    } else {
      await fetch('/api/landlord-contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    setIsModalOpen(false);
    setEditingContract(null);
    setPdfFile(null);
    fetchContracts();
  };

  const handleEdit = (contract: LandlordContract) => {
    setEditingContract(contract);
    setIsModalOpen(true);
  };

  const handleDelete = async (contract: LandlordContract) => {
    if (confirm(`確定要刪除「${contract.property_name}」嗎？`)) {
      await fetch(`/api/landlord-contracts?id=${contract.id}`, { method: 'DELETE' });
      fetchContracts();
    }
  };

  const columns = [
    { key: 'property_name', label: '物件名稱' },
    { key: 'rent', label: '租金', render: (v: number) => formatCurrency(v) },
    { key: 'start_date', label: '起租日', render: (v: string) => formatDate(v) },
    { 
      key: 'end_date', 
      label: '到期日',
      render: (v: string, row: LandlordContract) => (
        <div>
          <span>{formatDate(v)}</span>
          {isExpiringSoon(v) && (
            <span className="ml-2 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded">
              {getDaysUntilExpiry(v)}天後到期
            </span>
          )}
        </div>
      )
    },
    { key: 'address', label: '地址' },
    { 
      key: 'pdf_path', 
      label: '合約',
      render: (v: string | null) => v ? (
        <a href={v} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
          📄 查看
        </a>
      ) : '-'
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">📝 房東合約</h1>
        <button
          onClick={() => { setEditingContract(null); setIsModalOpen(true); }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          + 新增合約
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm">
        <DataTable
          columns={columns}
          data={contracts}
          onEdit={handleEdit}
          onDelete={handleDelete}
          emptyMessage="尚無房東合約"
        />
      </div>

      <FormModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingContract(null); setPdfFile(null); }}
        onSubmit={handleSubmit}
        title={editingContract ? '編輯房東合約' : '新增房東合約'}
        fields={fields}
        initialData={editingContract}
      />

      {isModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="p-6 border-b">
              <h2 className="text-xl font-semibold text-gray-800">
                {editingContract ? '編輯房東合約' : '新增房東合約'}
              </h2>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement); const data: Record<string, string> = {}; fd.forEach((v, k) => { data[k] = v.toString(); }); handleSubmit(data); }} className="p-6 space-y-4">
              {fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {field.label}
                    {field.required && <span className="text-red-500">*</span>}
                  </label>
                  <input
                    name={field.key}
                    type={field.type || 'text'}
                    defaultValue={(editingContract as any)?.[field.key] || ''}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    required={field.required}
                  />
                </div>
              ))}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">合約 PDF</label>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
                {editingContract?.pdf_path && (
                  <p className="text-sm text-gray-500 mt-1">已上傳過：{editingContract.pdf_path}</p>
                )}
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); setEditingContract(null); setPdfFile(null); }}
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
