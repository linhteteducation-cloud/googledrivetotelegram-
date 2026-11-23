import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let displayMessage = error.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(error.message) as { error?: string; operationType?: string };
      if (parsed && parsed.error) {
        displayMessage = `Database ${parsed.operationType || 'operation'} error: ${parsed.error}`;
      }
    } catch {
      // keep raw message
    }
    return {
      hasError: true,
      message: displayMessage,
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600">
                <AlertCircle className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Something went wrong
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {this.state.message}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              <RotateCcw className="h-4 w-4" />
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
