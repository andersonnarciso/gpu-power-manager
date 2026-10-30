import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';

export interface ErrorBoundaryProps {
  children: ReactNode;
  title: string;
  description: string;
  retryLabel: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a crash inside one page from blanking the whole application.
 *
 * The raw stack trace is only written to the developer console; the user sees
 * a readable, designed message.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4"
      >
        <div className="flex items-start gap-2.5">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-destructive">{this.props.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {this.props.description}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {this.props.retryLabel}
        </Button>
      </div>
    );
  }
}
