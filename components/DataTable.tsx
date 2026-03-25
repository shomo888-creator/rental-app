'use client';

interface Column {
  key: string;
  label: string;
  render?: (value: any, row: any) => React.ReactNode;
}

interface DataTableProps {
  columns: Column[];
  data: any[];
  onEdit: (row: any) => void;
  onDelete: (row: any) => void;
  emptyMessage?: string;
}

export default function DataTable({ columns, data, onEdit, onDelete, emptyMessage = '暫無資料' }: DataTableProps) {
  if (data.length === 0) {
    return <p className="text-gray-500 text-center py-12">{emptyMessage}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-gray-50">
            {columns.map((col) => (
              <th key={col.key} className="px-4 py-3 text-left text-sm font-semibold text-gray-600">
                {col.label}
              </th>
            ))}
            <th className="px-4 py-3 text-right text-sm font-semibold text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.map((row, idx) => (
            <tr key={idx} className="hover:bg-gray-50">
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-3 text-sm text-gray-700">
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </td>
              ))}
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onEdit(row)}
                  className="text-blue-600 hover:text-blue-800 mr-3 text-sm font-medium"
                >
                  編輯
                </button>
                <button
                  onClick={() => onDelete(row)}
                  className="text-red-600 hover:text-red-800 text-sm font-medium"
                >
                  刪除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
