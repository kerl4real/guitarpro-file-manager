"""Tkinter comparison prototype. Run: python desktop.py"""
import argparse
import json
import queue
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from core import Library, default_directory, default_parser, open_score


class Desktop:
    def __init__(self, root, library):
        self.root, self.library = root, library
        self.events = queue.Queue()
        self.busy = False
        self.sort, self.descending = 'title', False
        self.rows = {}
        root.title('guitarpro-file-manager · Tkinter prototype')
        root.geometry('1200x760')
        root.minsize(850, 500)
        self.parser = tk.StringVar(value=default_parser())
        self.search = tk.StringVar()
        self.format = tk.StringVar()
        self.status = tk.StringVar()
        self.message = tk.StringVar(value='Scan a folder or import parser JSONL to start your library.')
        outer = ttk.Frame(root, padding=16)
        outer.pack(fill='both', expand=True)
        ttk.Label(outer, text='Guitar Pro File Manager', font=('', 22, 'bold')).pack(anchor='w')
        ttk.Label(outer, text='Your scores, organized by their metadata.').pack(anchor='w', pady=(0, 12))
        parser_bar = ttk.Frame(outer)
        parser_bar.pack(fill='x')
        ttk.Label(parser_bar, text='Parser').pack(side='left')
        ttk.Entry(parser_bar, textvariable=self.parser).pack(side='left', fill='x', expand=True, padx=8)
        ttk.Button(parser_bar, text='Browse…', command=self.choose_parser).pack(side='left')
        actions = ttk.Frame(outer)
        actions.pack(fill='x', pady=12)
        self.scan_button = ttk.Button(actions, text='Scan folder…', command=self.scan)
        self.scan_button.pack(side='left')
        self.import_button = ttk.Button(actions, text='Import JSONL…', command=self.import_file)
        self.import_button.pack(side='left', padx=8)
        ttk.Button(actions, text='Open selected score', command=self.open).pack(side='left')
        filters = ttk.Frame(outer)
        filters.pack(fill='x', pady=(0, 12))
        ttk.Entry(filters, textvariable=self.search).pack(side='left', fill='x', expand=True)
        ttk.Label(filters, text='Format').pack(side='left', padx=8)
        ttk.Combobox(filters, textvariable=self.format, values=('', 'GP3', 'GP4', 'GP5', 'GPX', 'GP', 'MSCZ'), state='readonly', width=8).pack(side='left')
        ttk.Label(filters, text='Status').pack(side='left', padx=8)
        ttk.Combobox(filters, textvariable=self.status, values=('', 'ok', 'error'), state='readonly', width=8).pack(side='left')
        panels = ttk.Panedwindow(outer, orient='vertical')
        panels.pack(fill='both', expand=True)
        table_frame = ttk.Frame(panels)
        columns = ('title', 'artist', 'album', 'format', 'tempo', 'tracks', 'status', 'path')
        self.table = ttk.Treeview(table_frame, columns=columns, show='headings', selectmode='browse')
        for column in columns:
            self.table.heading(column, text=column.title(), command=lambda c=column: self.order(c))
            self.table.column(column, width=65 if column in ('format', 'tempo', 'tracks', 'status') else 180, minwidth=50)
        vertical = ttk.Scrollbar(table_frame, orient='vertical', command=self.table.yview)
        horizontal = ttk.Scrollbar(table_frame, orient='horizontal', command=self.table.xview)
        self.table.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        self.table.grid(row=0, column=0, sticky='nsew')
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal.grid(row=1, column=0, sticky='ew')
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)
        panels.add(table_frame, weight=3)
        self.details = tk.Text(panels, height=10, wrap='word', state='disabled')
        panels.add(self.details, weight=1)
        self.table.bind('<<TreeviewSelect>>', self.select)
        self.table.bind('<Double-1>', lambda event: self.open())
        ttk.Label(outer, textvariable=self.message, wraplength=1100).pack(anchor='w', pady=(10, 0))
        for variable in (self.search, self.format, self.status):
            variable.trace_add('write', lambda *args: self.refresh())
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.refresh()
        root.after(100, self.poll)

    def choose_parser(self):
        path = filedialog.askopenfilename(title='Select score_tool executable')
        if path:
            self.parser.set(path)

    def order(self, column):
        self.descending = not self.descending if self.sort == column else False
        self.sort = column
        self.refresh()

    def refresh(self):
        self.table.delete(*self.table.get_children())
        rows = self.library.query(self.search.get(), self.format.get(), self.status.get(), self.sort, self.descending)
        self.rows = {str(i): row for i, row in enumerate(rows)}
        for key, row in self.rows.items():
            self.table.insert('', 'end', iid=key, values=[row[c] if row[c] is not None else '' for c in self.table['columns']])
        self.details.configure(state='normal')
        self.details.delete('1.0', 'end')
        self.details.configure(state='disabled')
        if not self.busy:
            self.message.set(f'{len(rows)} files · Library: {self.library.database}')

    def select(self, event=None):
        selected = self.table.selection()
        if selected:
            record = json.loads(self.rows[selected[0]]['record'])
            self.details.configure(state='normal')
            self.details.delete('1.0', 'end')
            self.details.insert('1.0', json.dumps(record, indent=2, ensure_ascii=False))
            self.details.configure(state='disabled')

    def open(self):
        selected = self.table.selection()
        if selected:
            try:
                open_score(self.rows[selected[0]]['path'])
            except (OSError, ValueError) as error:
                messagebox.showerror('Cannot open score', str(error))

    def work(self, operation):
        if self.busy:
            return
        self.busy = True
        for button in (self.scan_button, self.import_button):
            button.configure(state='disabled')
        self.message.set('Working…')
        def run():
            try:
                self.events.put(('done', operation()))
            except Exception as error:
                self.events.put(('error', str(error)))
        threading.Thread(target=run, daemon=True).start()

    def scan(self):
        folder = filedialog.askdirectory(title='Select score folder')
        parser = self.parser.get()
        if folder:
            self.work(lambda: self.library.scan(parser, folder, lambda n: self.events.put(('progress', n))))

    def import_file(self):
        path = filedialog.askopenfilename(title='Import parser scan', filetypes=[('JSON Lines', '*.jsonl'), ('All files', '*')])
        if path:
            self.work(lambda: (self.library.import_jsonl(path), path))

    def poll(self):
        for _ in range(100):
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == 'progress':
                self.message.set(f'Extracted {value} records…')
            else:
                self.busy = False
                for button in (self.scan_button, self.import_button):
                    button.configure(state='normal')
                self.refresh()
                if kind == 'error':
                    messagebox.showerror('Import failed', value)
                    self.message.set(value)
                else:
                    self.message.set(f'Imported {value[0]} records · {value[1]}')
        self.root.after(100, self.poll)

    def close(self):
        if self.busy:
            messagebox.showinfo('Scan running', 'Wait for the import to finish before closing this prototype.')
        else:
            self.root.destroy()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', default=str(default_directory()))
    args = parser.parse_args()
    root = tk.Tk()
    Desktop(root, Library(args.data_dir))
    root.mainloop()
