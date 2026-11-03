import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
    createWhiteboard,
    type ChangeEvent,
    type Whiteboard as WhiteboardInstance,
    type WhiteboardOptions,
} from 'liteboard';
import { mountToolbar, type ToolbarOptions } from 'liteboard/ui';

export interface WhiteboardProps extends Omit<WhiteboardOptions, 'underlay' | 'style'> {
    className?: string;
    /** CSS for the board's container. */
    style?: CSSProperties;
    /** Starting colour, stroke width and font size (`style` in the core API). */
    drawStyle?: WhiteboardOptions['style'];
    /** Content drawn under the strokes that pans and zooms with them. */
    underlay?: ReactNode;
    /** Built-in toolbar. Default true; pass false to build your own. */
    toolbar?: boolean | ToolbarOptions;
    onReady?: (wb: WhiteboardInstance) => void;
    onChange?: (event: ChangeEvent, wb: WhiteboardInstance) => void;
}

// useLayoutEffect warns during server rendering; the board is client-only.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The board, sized to its parent. `tools`, `style`, `gestures` and the other
 * options are read once; `theme`, `readOnly` and `boardId` follow props.
 * Changing `boardId` switches boards (pass the new board's `scene` with it).
 */
export const Whiteboard = forwardRef<WhiteboardInstance | null, WhiteboardProps>(
    function Whiteboard(props, ref) {
        const containerRef = useRef<HTMLDivElement>(null);
        const latest = useRef(props);
        latest.current = props;
        const [wb, setWb] = useState<WhiteboardInstance | null>(null);
        const [underlayEl] = useState(() =>
            typeof document === 'undefined' ? null : document.createElement('div'),
        );
        const loadedBoard = useRef(props.boardId);

        useImperativeHandle(ref, () => wb as WhiteboardInstance, [wb]);

        useIsoLayoutEffect(() => {
            const {
                toolbar,
                onReady,
                onChange: _onChange,
                underlay,
                className: _className,
                style: _style,
                drawStyle,
                ...options
            } = latest.current;
            const board = createWhiteboard(containerRef.current!, {
                ...options,
                style: drawStyle,
                underlay: underlay !== undefined && underlayEl ? underlayEl : undefined,
            });
            const bar =
                toolbar === false
                    ? null
                    : mountToolbar(board, typeof toolbar === 'object' ? toolbar : {});
            const off = board.on('change', (e) => latest.current.onChange?.(e, board));
            loadedBoard.current = options.boardId;
            setWb(board);
            onReady?.(board);
            return () => {
                off();
                bar?.destroy();
                board.destroy();
                setWb(null);
            };
        }, []);

        useEffect(() => {
            if (wb && props.theme) wb.setTheme(props.theme);
        }, [wb, props.theme]);

        useEffect(() => {
            if (wb) wb.setReadOnly(props.readOnly ?? false);
        }, [wb, props.readOnly]);

        useEffect(() => {
            if (!wb || loadedBoard.current === props.boardId) return;
            loadedBoard.current = props.boardId;
            wb.load(props.boardId, latest.current.scene);
        }, [wb, props.boardId]);

        return (
            <div
                ref={containerRef}
                className={props.className}
                style={{ position: 'relative', width: '100%', height: '100%', ...props.style }}
            >
                {wb && underlayEl && props.underlay !== undefined
                    ? createPortal(props.underlay, underlayEl)
                    : null}
            </div>
        );
    },
);

export type { WhiteboardInstance };
