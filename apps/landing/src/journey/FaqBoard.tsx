import { useState } from 'react';

export interface FaqItem {
  id: string
  q: string
  a?: string
}

interface FaqBoardProps {
  columns: readonly (readonly FaqItem[])[]
}

export default function FaqBoard({ columns }: FaqBoardProps) {
  const [openFaq, setOpenFaq] = useState<string | null>('register');

  return (
    <div className="faq-columns">
      {columns.map((column, columnIndex) => (
        <ul className="faq-column" key={columnIndex}>
          <span className="rope rope--near" aria-hidden="true" />
          <span className="rope rope--far" aria-hidden="true" />
          {column.map((item) => {
            const open = openFaq === item.id;
            return (
              <li className="plank" key={item.id}>
                <h3 className="plank__heading">
                  <button
                    className="plank__face"
                    type="button"
                    aria-expanded={open}
                    aria-controls={`faq-${item.id}`}
                    onClick={() => setOpenFaq((current) => (current === item.id ? null : item.id))}
                  >
                    <span>{item.q}</span>
                    <svg className="plank__chevron" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M 3 5.5 L 8 10.5 L 13 5.5" />
                    </svg>
                  </button>
                </h3>
                <div className="plank__answer" id={`faq-${item.id}`} data-open={open ? 'true' : 'false'}>
                  <div className="plank__answer-clip">
                    <p>{item.a ?? 'Answers go live closer to the event. Watch this space.'}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}
