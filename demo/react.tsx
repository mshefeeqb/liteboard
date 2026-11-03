import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Whiteboard, type WhiteboardInstance } from 'liteboard/react';

function App() {
    const board = useRef<WhiteboardInstance | null>(null);
    const [topic, setTopic] = useState(1);
    const [theme, setTheme] = useState<'light' | 'dark'>('light');
    const [count, setCount] = useState(0);
    return (
        <>
            <header>
                <button onClick={() => setTopic((t) => (t === 1 ? 2 : 1))}>Topic {topic}</button>
                <button onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>{theme}</button>
                <button onClick={() => board.current?.undo()}>Undo</button>
                <span>{count} elements</span>
            </header>
            <div style={{ flex: 1, background: theme === 'dark' ? '#121212' : '#fff' }}>
                <Whiteboard
                    ref={board}
                    boardId={`topic-${topic}`}
                    theme={theme}
                    drawStyle={{ strokeWidth: 1 }}
                    penResetsWidth
                    gestures={{ pinchZoom: false }}
                    underlay={
                        <div className="lesson" style={{ color: theme === 'dark' ? '#ddd' : '#222' }}>
                            <h2>Topic {topic}</h2>
                            <p>Underlay content rendered by React.</p>
                        </div>
                    }
                    onChange={(_e, wb) => setCount(wb.getElements().length)}
                />
            </div>
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
