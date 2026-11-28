// TaskBoard: the desktop testbed's SwiftUI app. It holds the surfaces the AppKit sign-in form has none of: a split view
// with a sidebar that does not scroll beside a list that does, a sheet, an alert, a popover, a stepper, a toolbar menu,
// a lazy 200-row list, tabs, a second window, and a window with no control that takes keyboard focus. Adapted from the
// sample @okwasniewski posted on #2324.
import AppKit
import SwiftUI

struct TaskItem: Identifiable, Hashable {
  let id = UUID()
  var title: String
  var project: String
  var done = false
  var priority = "Medium"
  var notes = ""
  var estimate = 1
}

@MainActor final class Store: ObservableObject {
  @Published var tasks: [TaskItem] = []
  @Published var status = "Ready"
  @Published var syncing = false
  @Published var showCompleted = true
  @Published var theme = "System"
  @Published var fontSize = 13.0
  @Published var server = "https://example.test"
  let projects = ["Inbox", "Work", "Home", "Archive"]

  init() {
    tasks = [
      TaskItem(title: "Buy milk", project: "Inbox"),
      TaskItem(title: "Call the bank", project: "Inbox", priority: "High"),
      TaskItem(title: "Write release notes", project: "Work", priority: "High"),
      TaskItem(title: "Review pull request", project: "Work"),
      TaskItem(title: "Water the plants", project: "Home", priority: "Low"),
    ] + (1...200).map { TaskItem(title: "Archived task \($0)", project: "Archive", done: true, priority: "Low") }
  }

  func sync() {
    syncing = true
    status = "Syncing…"
    Task {
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      syncing = false
      status = "Synced \(tasks.filter { !$0.done }.count) open tasks"
    }
  }
}

struct NewTaskSheet: View {
  @Environment(\.dismiss) var dismiss
  @State var title = ""
  @State var priority = "Medium"
  @State var estimate = 1
  @State var notes = ""
  @State var flagged = false
  let save: (String, String, Int, String, Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("New Task").font(.headline)
      TextField("Title", text: $title).accessibilityIdentifier("new-title")
      Picker("Priority", selection: $priority) {
        ForEach(["Low", "Medium", "High"], id: \.self) { Text($0) }
      }.pickerStyle(.segmented).accessibilityIdentifier("new-priority")
      Stepper("Estimate: \(estimate) h", value: $estimate, in: 1...12).accessibilityIdentifier("new-estimate")
      Toggle("Flagged", isOn: $flagged).accessibilityIdentifier("new-flagged")
      Text("Notes")
      TextEditor(text: $notes).frame(height: 70).accessibilityIdentifier("new-notes").accessibilityLabel("Notes")
      HStack {
        Button("Cancel", role: .cancel) { dismiss() }
        Spacer()
        Button("Save") { save(title, priority, estimate, notes, flagged); dismiss() }
          .keyboardShortcut(.defaultAction)
          .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }.padding(20).frame(width: 360)
  }
}

struct ContentView: View {
  @EnvironmentObject var store: Store
  @Environment(\.openWindow) var openWindow
  @State var project: String? = "Inbox"
  @State var query = ""
  @State var showNew = false
  @State var deleting: TaskItem?
  @State var selected: TaskItem.ID?
  @State var sortByPriority = false
  @State var showInfo = false

  var visible: [TaskItem] {
    var list = store.tasks.filter { $0.project == project }
    if !store.showCompleted { list = list.filter { !$0.done } }
    if !query.isEmpty { list = list.filter { $0.title.localizedCaseInsensitiveContains(query) } }
    if sortByPriority {
      let rank = ["High": 0, "Medium": 1, "Low": 2]
      list.sort { rank[$0.priority]! < rank[$1.priority]! }
    }
    return list
  }

  var body: some View {
    NavigationSplitView {
      List(store.projects, id: \.self, selection: $project) { name in
        HStack {
          Text(name)
          Spacer()
          Text("\(store.tasks.filter { $0.project == name && !$0.done }.count)").foregroundStyle(.secondary)
        }.accessibilityElement(children: .combine).accessibilityIdentifier("project-\(name)")
      }.navigationSplitViewColumnWidth(160)
    } detail: {
      VStack(alignment: .leading, spacing: 0) {
        List(selection: $selected) {
          ForEach(visible) { task in
            HStack {
              Toggle(task.title, isOn: binding(task).done).toggleStyle(.checkbox)
              Spacer()
              Text(task.priority).foregroundStyle(.secondary).accessibilityIdentifier("priority")
              Button("Delete") { deleting = task }.buttonStyle(.borderless).accessibilityLabel("Delete \(task.title)")
            }
            .tag(task.id)
            .contextMenu {
              Button("Mark High Priority") { update(task) { $0.priority = "High" }; store.status = "Marked \(task.title) high" }
              Button("Duplicate") { store.tasks.append(TaskItem(title: task.title + " copy", project: task.project)); store.status = "Duplicated \(task.title)" }
            }
          }
        }.accessibilityIdentifier("tasks")
        if let id = selected, let task = store.tasks.first(where: { $0.id == id }) {
          DisclosureGroup("Details") {
            VStack(alignment: .leading) {
              Text("Estimate: \(task.estimate) h").accessibilityIdentifier("detail-estimate")
              Text(task.notes.isEmpty ? "No notes" : task.notes).accessibilityIdentifier("detail-notes")
            }
          }.padding(8)
        }
        Divider()
        HStack {
          if store.syncing { ProgressView().controlSize(.small) }
          Text(store.status).accessibilityIdentifier("status")
          Spacer()
          Text("\(visible.count) shown").accessibilityIdentifier("count")
        }.padding(8)
      }
      .navigationTitle(project ?? "Tasks")
      .searchable(text: $query, prompt: "Search tasks")
      .toolbar {
        Button("New Task") { showNew = true }.keyboardShortcut("n")
        Button("Sync") { store.sync() }.disabled(store.syncing)
        Menu("Sort") {
          Button("By Title") { sortByPriority = false; store.status = "Sorted by title" }
          Button("By Priority") { sortByPriority = true; store.status = "Sorted by priority" }
        }
        Button("Info") { showInfo = true }
          .popover(isPresented: $showInfo) { Text("TaskBoard 1.0, a desktop engine sample").padding().accessibilityIdentifier("info-text") }
        Button("Preferences") { openWindow(id: "prefs") }
        Button("Keypad") { openWindow(id: "keypad") }
      }
    }
    .sheet(isPresented: $showNew) {
      NewTaskSheet { title, priority, estimate, notes, flagged in
        store.tasks.append(TaskItem(title: title, project: project ?? "Inbox", priority: priority, notes: notes, estimate: estimate))
        store.status = "Added \(title)\(flagged ? " (flagged)" : "")"
      }
    }
    .alert("Delete task?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { task in
      Button("Delete", role: .destructive) { store.tasks.removeAll { $0.id == task.id }; store.status = "Deleted \(task.title)" }
      Button("Cancel", role: .cancel) {}
    } message: { task in Text("\"\(task.title)\" will be removed.") }
  }

  func binding(_ task: TaskItem) -> Binding<TaskItem> {
    Binding(get: { store.tasks.first { $0.id == task.id } ?? task }, set: { new in update(task) { $0 = new } })
  }

  func update(_ task: TaskItem, _ change: (inout TaskItem) -> Void) {
    if let index = store.tasks.firstIndex(where: { $0.id == task.id }) { change(&store.tasks[index]) }
  }
}

struct PrefsView: View {
  @EnvironmentObject var store: Store
  var body: some View {
    TabView {
      Form {
        Toggle("Show completed", isOn: $store.showCompleted)
        Picker("Theme", selection: $store.theme) { ForEach(["System", "Light", "Dark"], id: \.self) { Text($0) } }
        Slider(value: $store.fontSize, in: 10...24, step: 1) { Text("Font size") }
        Text("Font size \(Int(store.fontSize))").accessibilityIdentifier("font-size")
      }.padding().tabItem { Text("General") }
      Form {
        TextField("Server", text: $store.server).accessibilityIdentifier("server")
        Button("Reset") { store.server = "https://example.test"; store.theme = "System" }
        Text("Server is \(store.server)").accessibilityIdentifier("server-echo")
      }.padding().tabItem { Text("Advanced") }
    }.frame(width: 380, height: 220).padding()
  }
}

/// A window with no control that takes keyboard focus, as Calculator's: digits typed while it is the key window show in
/// its display, and Delete removes the last one.
struct KeypadView: View {
  @State var display = ""
  @State var monitor: Any?

  var body: some View {
    VStack(spacing: 8) {
      Text("Type digits").foregroundStyle(.secondary)
      Text(display.isEmpty ? "Empty" : display).font(.title).accessibilityIdentifier("keypad-display")
    }
    .frame(width: 240, height: 120)
    .onAppear {
      monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
        // An app in the background has no key window: a key posted to it is the keypad's while the keypad is up.
        let keypad = event.window?.title == "Keypad" || (event.window == nil && NSApp.windows.contains { $0.title == "Keypad" && $0.isVisible })
        guard keypad else { return event }
        if event.keyCode == 51 {
          display = String(display.dropLast())
        } else if let characters = event.charactersIgnoringModifiers, !characters.isEmpty, characters.allSatisfy(\.isNumber) {
          display += characters
        } else {
          return event
        }
        return nil
      }
    }
    .onDisappear {
      if let monitor { NSEvent.removeMonitor(monitor) }
    }
  }
}

@main struct TaskBoardApp: App {
  @StateObject var store = Store()
  var body: some Scene {
    WindowGroup("TaskBoard", id: "main") { ContentView().environmentObject(store).frame(minWidth: 720, minHeight: 460) }
    Window("Preferences", id: "prefs") { PrefsView().environmentObject(store) }
    Window("Keypad", id: "keypad") { KeypadView() }
  }
}
