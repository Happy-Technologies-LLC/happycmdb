// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Icon } from "@happy-technologies/design-system"
import { cn } from "@/lib/utils"

const FormDialog = DialogPrimitive.Root

const FormDialogTrigger = DialogPrimitive.Trigger

const FormDialogPortal = DialogPrimitive.Portal

const FormDialogClose = DialogPrimitive.Close

const FormDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/10 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    style={{
      backdropFilter: 'blur(1px)',
      WebkitBackdropFilter: 'blur(1px)',
    }}
    {...props}
  />
))
FormDialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const FormDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const glassId = React.useId();
  const bendClass = `form-dialog-glass--bend-${glassId.replace(/:/g, '-')}`;

  return (
    <FormDialogPortal>
      <FormDialogOverlay />

      {/* SVG filter for glass effect */}
      <svg style={{ display: 'none' }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id={`form-dialog-glass-blur-${glassId}`} x="0" y="0" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.003 0.007" numOctaves="1" result="turbulence" />
            <feDisplacementMap in="SourceGraphic" in2="turbulence" scale="200" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      {/* Pseudo-element styles for gradient */}
      <style>{`
        .${bendClass}::before {
          content: '';
          position: absolute;
          inset: -40px;
          border-radius: inherit;
          background: radial-gradient(circle at top left, rgba(59, 130, 246, 0.1) 0%, transparent 50%), radial-gradient(circle at bottom right, rgba(239, 68, 68, 0.1) 0%, transparent 50%);
          z-index: -1;
        }
      `}</style>

      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-[50%] top-[50%] z-50 flex flex-col w-full max-w-7xl -translate-x-1/2 -translate-y-1/2 border duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-2xl",
          // Base glassmorphism container - adjusted height
          "overflow-hidden",
          "max-h-[85vh]", // Limit height to 85% of viewport
          className
        )}
        style={{
          boxShadow: '0 4px 6px rgba(59, 130, 246, 0.15), 0 2px 4px rgba(239, 68, 68, 0.1), 0 8px 16px rgba(59, 130, 246, 0.1), 0 8px 16px rgba(239, 68, 68, 0.08)',
        }}
        {...props}
      >
        {/* Bend layer - light backdrop blur with gradient background */}
        <div
          className={cn('absolute inset-0 rounded-2xl', bendClass)}
          style={{
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
            filter: `url(#form-dialog-glass-blur-${glassId})`,
          }}
        />

        {/* Face layer - subtle outer shadows for depth */}
        <div
          className="absolute inset-0 rounded-2xl"
          style={{
            boxShadow: '0 4px 4px rgba(0, 0, 0, 0.15), 0 0 12px rgba(0, 0, 0, 0.08)',
          }}
        />

        {/* Edge layer - crisp inner highlights for glass effect */}
        <div
          className="absolute inset-0 pointer-events-none rounded-2xl"
          style={{
            boxShadow: 'inset 3px 3px 3px 0 rgba(255, 255, 255, 0.45), inset -3px -3px 3px 0 rgba(255, 255, 255, 0.45)',
          }}
        />

        {/* Close button - fixed at top right */}
        <DialogPrimitive.Close className="absolute right-4 top-4 z-20 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <Icon name="x" size={16} />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>

        {/* Content wrapper with scroll */}
        <div className="relative z-10 flex flex-col overflow-hidden">
          {children}
        </div>
      </DialogPrimitive.Content>
    </FormDialogPortal>
  );
})
FormDialogContent.displayName = DialogPrimitive.Content.displayName

const FormDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 px-6 pt-6 pb-4 border-b border-border/50",
      className
    )}
    {...props}
  />
)
FormDialogHeader.displayName = "FormDialogHeader"

const FormDialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex-1 overflow-y-auto px-6 py-4",
      className
    )}
    {...props}
  />
)
FormDialogBody.displayName = "FormDialogBody"

const FormDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 px-6 py-4 border-t border-border/50",
      className
    )}
    {...props}
  />
)
FormDialogFooter.displayName = "FormDialogFooter"

const FormDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
FormDialogTitle.displayName = DialogPrimitive.Title.displayName

const FormDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
FormDialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  FormDialog,
  FormDialogPortal,
  FormDialogOverlay,
  FormDialogTrigger,
  FormDialogClose,
  FormDialogContent,
  FormDialogHeader,
  FormDialogBody,
  FormDialogFooter,
  FormDialogTitle,
  FormDialogDescription,
}
