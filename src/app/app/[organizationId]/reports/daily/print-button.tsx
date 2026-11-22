"use client";

export default function PrintReportButton() {
  return <button type="button" onClick={() => window.print()} style={{padding:"10px 13px",border:"1px solid var(--line)",borderRadius:9,background:"white",color:"var(--ink)",fontWeight:750,cursor:"pointer"}}>Printo / Ruaj PDF</button>;
}
