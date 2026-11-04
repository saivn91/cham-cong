import React from 'react';

// Bố cục Kiosk: Toàn màn hình, nền tối, tối ưu cho cảm ứng, không có thanh điều hướng
export const KioskLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="kiosk-shell safe-area-pad min-h-screen w-screen bg-slate-950 text-white overflow-hidden select-none touch-manipulation flex flex-col">
      <main className="flex-1 w-full h-full flex flex-col">
        {children}
      </main>
    </div>
  );
};

export default KioskLayout;
