# MiMo Agentic Coding TUI 技术实现方案

## 一、技术架构详解

### 1.1 分层架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                     Presentation Layer (TUI)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Chat View   │  │  File View   │  │ Terminal View│          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Task View   │  │  Output View │  │ Status Bar   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
├─────────────────────────────────────────────────────────────────┤
│                     Application Layer                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Chat Service │  │ File Service │  │Terminal Svc  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Task Service │  │ Git Service  │  │ Tool Service │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
├─────────────────────────────────────────────────────────────────┤
│                     Domain Layer                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Reasoning   │  │    Context   │  │    Tool      │          │
│  │   Engine     │  │   Manager    │  │   Manager    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    Task      │  │   Session    │  │   Project    │          │
│  │  Scheduler   │  │   Manager    │  │   Analyzer   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
├─────────────────────────────────────────────────────────────────┤
│                     Infrastructure Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ MiMo Client  │  │  Git Client  │  │Terminal Client│         │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ File System  │  │   Database   │  │    Cache     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心组件关系

```python
# 组件依赖关系
class ComponentDiagram:
    """
    TUI App
        ├── ChatService
        │   ├── ReasoningEngine
        │   ├── ContextManager
        │   └── SessionManager
        ├── FileService
        │   ├── FileSystem
        │   └── ProjectAnalyzer
        ├── TerminalService
        │   └── TerminalClient
        ├── TaskService
        │   ├── TaskScheduler
        │   └── ToolManager
        └── GitService
            └── GitClient
    """
```

## 二、核心模块实现

### 2.1 TUI界面实现 (Python Textual)

```python
# app.py - 主应用入口
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.widgets import Header, Footer, Static, Input, Button
from textual.binding import Binding

from .services import ChatService, FileService, TerminalService
from .components import ChatPanel, FilePanel, TerminalPanel, OutputPanel


class MiMoTUI(App):
    """MiMo Agentic Coding TUI 主应用"""
    
    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit"),
        Binding("ctrl+l", "clear", "Clear"),
        Binding("ctrl+o", "open_file", "Open File"),
        Binding("ctrl+s", "save_file", "Save File"),
        Binding("ctrl+g", "git_status", "Git Status"),
        Binding("ctrl+t", "toggle_terminal", "Terminal"),
        Binding("f1", "help", "Help"),
    ]
    
    CSS = """
    Screen {
        layout: grid;
        grid-size: 2;
        grid-columns: 1fr 2fr;
        grid-rows: 3fr 1fr;
    }
    
    #sidebar {
        row-span: 2;
        border-right: solid $primary;
    }
    
    #chat-panel {
        border-bottom: solid $primary;
    }
    
    #output-panel {
        border-top: solid $primary;
    }
    """
    
    def __init__(self):
        super().__init__()
        self.chat_service = ChatService()
        self.file_service = FileService()
        self.terminal_service = TerminalService()
        self.current_file = None
    
    def compose(self) -> ComposeResult:
        """构建界面布局"""
        yield Header()
        
        with Container(id="sidebar"):
            yield FilePanel(id="file-panel")
        
        with Vertical(id="main"):
            yield ChatPanel(id="chat-panel")
            yield OutputPanel(id="output-panel")
        
        with Container(id="input-area"):
            yield Input(placeholder="Type your message...", id="input")
        
        yield Footer()
    
    def on_input_submitted(self, event: Input.Submitted) -> None:
        """处理用户输入"""
        user_input = event.value
        if user_input.strip():
            self.process_input(user_input)
            event.input.value = ""
    
    def process_input(self, user_input: str) -> None:
        """处理用户输入"""
        # 显示用户消息
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.add_message("user", user_input)
        
        # 处理命令
        if user_input.startswith("/"):
            self.handle_command(user_input)
        else:
            self.handle_chat(user_input)
    
    def handle_command(self, command: str) -> None:
        """处理命令"""
        parts = command.split()
        cmd = parts[0].lower()
        
        if cmd == "/help":
            self.show_help()
        elif cmd == "/open":
            self.open_file(parts[1] if len(parts) > 1 else None)
        elif cmd == "/save":
            self.save_file()
        elif cmd == "/git":
            self.git_command(parts[1:])
        elif cmd == "/clear":
            self.action_clear()
        else:
            self.show_error(f"Unknown command: {cmd}")
    
    def handle_chat(self, message: str) -> None:
        """处理聊天消息"""
        # 获取上下文
        context = self.get_context()
        
        # 调用推理引擎
        response = self.chat_service.process(message, context)
        
        # 显示响应
        chat_panel = self.query_one("#chat-panel", ChatPanel)
        chat_panel.add_message("assistant", response)
    
    def get_context(self) -> dict:
        """获取当前上下文"""
        return {
            "current_file": self.current_file,
            "project_root": self.file_service.get_project_root(),
            "open_files": self.file_service.get_open_files(),
            "git_status": self.terminal_service.run_command("git status --short"),
        }
```

### 2.2 推理引擎实现

```python
# reasoning_engine.py
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from enum import Enum

from .mimo_client import MiMoClient
from .context_manager import ContextManager
from .tool_manager import ToolManager


class IntentType(Enum):
    """用户意图类型"""
    CODE_GENERATION = "code_generation"
    CODE_EXPLANATION = "code_explanation"
    CODE_MODIFICATION = "code_modification"
    DEBUGGING = "debugging"
    FILE_OPERATION = "file_operation"
    GIT_OPERATION = "git_operation"
    TERMINAL_COMMAND = "terminal_command"
    QUESTION = "question"
    UNKNOWN = "unknown"


@dataclass
class UserIntent:
    """用户意图"""
    type: IntentType
    confidence: float
    parameters: Dict[str, Any]
    raw_input: str


@dataclass
class ExecutionPlan:
    """执行计划"""
    steps: List[Dict[str, Any]]
    estimated_time: float
    risk_level: str
    requires_confirmation: bool


class ReasoningEngine:
    """推理引擎核心类"""
    
    def __init__(self, mimo_client: MiMoClient):
        self.mimo = mimo_client
        self.context_manager = ContextManager()
        self.tool_manager = ToolManager()
        self.intent_classifier = IntentClassifier(mimo_client)
    
    def process(self, user_input: str, context: Dict[str, Any]) -> str:
        """处理用户输入"""
        # 1. 理解用户意图
        intent = self.understand_intent(user_input, context)
        
        # 2. 获取相关上下文
        relevant_context = self.get_relevant_context(intent, context)
        
        # 3. 制定执行计划
        plan = self.create_plan(intent, relevant_context)
        
        # 4. 执行计划
        result = self.execute_plan(plan)
        
        # 5. 生成响应
        response = self.generate_response(intent, result)
        
        return response
    
    def understand_intent(self, user_input: str, context: Dict[str, Any]) -> UserIntent:
        """理解用户意图"""
        # 使用MiMo模型进行意图分类
        prompt = f"""
        分析以下用户输入，识别其意图类型和参数。
        
        用户输入: {user_input}
        
        上下文信息:
        - 当前文件: {context.get('current_file', 'None')}
        - 项目类型: {context.get('project_type', 'Unknown')}
        
        请返回JSON格式的意图分析结果:
        {{
            "type": "意图类型",
            "confidence": 0.95,
            "parameters": {{}},
            "reasoning": "推理过程"
        }}
        """
        
        response = self.mimo.generate(prompt)
        intent_data = self.parse_intent_response(response)
        
        return UserIntent(
            type=IntentType(intent_data['type']),
            confidence=intent_data['confidence'],
            parameters=intent_data['parameters'],
            raw_input=user_input
        )
    
    def get_relevant_context(self, intent: UserIntent, context: Dict[str, Any]) -> Dict[str, Any]:
        """获取相关上下文"""
        relevant_context = {
            'intent': intent,
            'timestamp': datetime.now(),
        }
        
        # 根据意图类型获取相关上下文
        if intent.type == IntentType.CODE_GENERATION:
            # 获取代码生成相关上下文
            relevant_context.update({
                'code_style': self.context_manager.get_code_style(),
                'dependencies': self.context_manager.get_dependencies(),
                'similar_examples': self.context_manager.find_similar_examples(intent.parameters),
            })
        
        elif intent.type == IntentType.DEBUGGING:
            # 获取调试相关上下文
            relevant_context.update({
                'error_info': self.context_manager.get_error_info(),
                'stack_trace': self.context_manager.get_stack_trace(),
                'related_files': self.context_manager.get_related_files(intent.parameters),
            })
        
        elif intent.type == IntentType.FILE_OPERATION:
            # 获取文件操作相关上下文
            relevant_context.update({
                'file_content': self.context_manager.get_file_content(intent.parameters.get('file')),
                'file_history': self.context_manager.get_file_history(intent.parameters.get('file')),
                'related_files': self.context_manager.get_related_files(intent.parameters),
            })
        
        return relevant_context
    
    def create_plan(self, intent: UserIntent, context: Dict[str, Any]) -> ExecutionPlan:
        """创建执行计划"""
        # 使用MiMo模型生成执行计划
        prompt = f"""
        基于以下意图和上下文，创建详细的执行计划。
        
        意图类型: {intent.type.value}
        意图参数: {intent.parameters}
        
        上下文信息:
        {json.dumps(context, indent=2, default=str)}
        
        请返回JSON格式的执行计划:
        {{
            "steps": [
                {{
                    "action": "操作类型",
                    "tool": "工具名称",
                    "parameters": {{}},
                    "description": "操作描述"
                }}
            ],
            "estimated_time": 10.5,
            "risk_level": "low",
            "requires_confirmation": false,
            "reasoning": "计划推理过程"
        }}
        """
        
        response = self.mimo.generate(prompt)
        plan_data = self.parse_plan_response(response)
        
        return ExecutionPlan(
            steps=plan_data['steps'],
            estimated_time=plan_data['estimated_time'],
            risk_level=plan_data['risk_level'],
            requires_confirmation=plan_data['requires_confirmation']
        )
    
    def execute_plan(self, plan: ExecutionPlan) -> Dict[str, Any]:
        """执行计划"""
        results = []
        
        for step in plan.steps:
            try:
                # 获取工具
                tool = self.tool_manager.get_tool(step['tool'])
                
                # 执行工具
                result = tool.execute(step['parameters'])
                
                results.append({
                    'step': step,
                    'result': result,
                    'status': 'success'
                })
            
            except Exception as e:
                results.append({
                    'step': step,
                    'error': str(e),
                    'status': 'failed'
                })
                
                # 根据错误类型决定是否继续
                if self.should_stop_on_error(e, step):
                    break
        
        return {
            'steps': results,
            'overall_status': self.calculate_overall_status(results)
        }
    
    def generate_response(self, intent: UserIntent, result: Dict[str, Any]) -> str:
        """生成响应"""
        # 使用MiMo模型生成自然语言响应
        prompt = f"""
        基于以下执行结果，生成用户友好的响应。
        
        用户意图: {intent.type.value}
        执行结果: {json.dumps(result, indent=2, default=str)}
        
        请生成清晰、有帮助的响应，包括:
        1. 执行结果的总结
        2. 遇到的问题（如果有）
        3. 后续建议（如果有）
        """
        
        response = self.mimo.generate(prompt)
        return response
```

### 2.3 工具管理器实现

```python
# tool_manager.py
from typing import Dict, List, Any, Optional, Callable
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
import inspect


class ToolCategory(Enum):
    """工具类别"""
    FILE = "file"
    TERMINAL = "terminal"
    GIT = "git"
    CODE = "code"
    TEST = "test"
    BUILD = "build"
    DEPLOY = "deploy"


@dataclass
class ToolInfo:
    """工具信息"""
    name: str
    category: ToolCategory
    description: str
    parameters: Dict[str, Any]
    required_permissions: List[str]


class Tool(ABC):
    """工具基类"""
    
    @abstractmethod
    def get_info(self) -> ToolInfo:
        """获取工具信息"""
        pass
    
    @abstractmethod
    def validate_parameters(self, parameters: Dict[str, Any]) -> bool:
        """验证参数"""
        pass
    
    @abstractmethod
    def execute(self, parameters: Dict[str, Any]) -> Any:
        """执行工具"""
        pass


class ToolManager:
    """工具管理器"""
    
    def __init__(self):
        self.tools: Dict[str, Tool] = {}
        self.tool_history: List[Dict[str, Any]] = []
        self.permission_manager = PermissionManager()
    
    def register_tool(self, tool: Tool) -> None:
        """注册工具"""
        info = tool.get_info()
        self.tools[info.name] = tool
    
    def get_tool(self, name: str) -> Tool:
        """获取工具"""
        if name not in self.tools:
            raise ToolNotFoundError(f"Tool not found: {name}")
        return self.tools[name]
    
    def list_tools(self, category: Optional[ToolCategory] = None) -> List[ToolInfo]:
        """列出工具"""
        tools = []
        for tool in self.tools.values():
            info = tool.get_info()
            if category is None or info.category == category:
                tools.append(info)
        return tools
    
    def call_tool(self, name: str, parameters: Dict[str, Any]) -> Any:
        """调用工具"""
        # 获取工具
        tool = self.get_tool(name)
        info = tool.get_info()
        
        # 检查权限
        self.permission_manager.check_permissions(info.required_permissions)
        
        # 验证参数
        if not tool.validate_parameters(parameters):
            raise InvalidParametersError(f"Invalid parameters for tool: {name}")
        
        # 执行工具
        try:
            result = tool.execute(parameters)
            
            # 记录历史
            self.tool_history.append({
                'tool': name,
                'parameters': parameters,
                'result': result,
                'status': 'success',
                'timestamp': datetime.now()
            })
            
            return result
        
        except Exception as e:
            # 记录错误
            self.tool_history.append({
                'tool': name,
                'parameters': parameters,
                'error': str(e),
                'status': 'failed',
                'timestamp': datetime.now()
            })
            raise


# 具体工具实现示例

class FileReadTool(Tool):
    """文件读取工具"""
    
    def get_info(self) -> ToolInfo:
        return ToolInfo(
            name="file_read",
            category=ToolCategory.FILE,
            description="读取文件内容",
            parameters={
                "path": {"type": "string", "required": True, "description": "文件路径"},
                "encoding": {"type": "string", "required": False, "default": "utf-8", "description": "文件编码"},
                "start_line": {"type": "integer", "required": False, "description": "起始行号"},
                "end_line": {"type": "integer", "required": False, "description": "结束行号"}
            },
            required_permissions=["file.read"]
        )
    
    def validate_parameters(self, parameters: Dict[str, Any]) -> bool:
        if "path" not in parameters:
            return False
        if not isinstance(parameters["path"], str):
            return False
        return True
    
    def execute(self, parameters: Dict[str, Any]) -> Any:
        path = parameters["path"]
        encoding = parameters.get("encoding", "utf-8")
        start_line = parameters.get("start_line")
        end_line = parameters.get("end_line")
        
        with open(path, 'r', encoding=encoding) as f:
            lines = f.readlines()
        
        if start_line is not None or end_line is not None:
            start = (start_line or 1) - 1
            end = end_line or len(lines)
            lines = lines[start:end]
        
        return {
            "content": "".join(lines),
            "lines": len(lines),
            "path": path
        }


class FileWriteTool(Tool):
    """文件写入工具"""
    
    def get_info(self) -> ToolInfo:
        return ToolInfo(
            name="file_write",
            category=ToolCategory.FILE,
            description="写入文件内容",
            parameters={
                "path": {"type": "string", "required": True, "description": "文件路径"},
                "content": {"type": "string", "required": True, "description": "文件内容"},
                "encoding": {"type": "string", "required": False, "default": "utf-8", "description": "文件编码"},
                "create_dirs": {"type": "boolean", "required": False, "default": False, "description": "创建目录"}
            },
            required_permissions=["file.write"]
        )
    
    def validate_parameters(self, parameters: Dict[str, Any]) -> bool:
        if "path" not in parameters or "content" not in parameters:
            return False
        return True
    
    def execute(self, parameters: Dict[str, Any]) -> Any:
        path = parameters["path"]
        content = parameters["content"]
        encoding = parameters.get("encoding", "utf-8")
        create_dirs = parameters.get("create_dirs", False)
        
        if create_dirs:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        
        with open(path, 'w', encoding=encoding) as f:
            f.write(content)
        
        return {
            "path": path,
            "bytes_written": len(content.encode(encoding)),
            "lines_written": content.count('\n') + 1
        }


class GitStatusTool(Tool):
    """Git状态工具"""
    
    def get_info(self) -> ToolInfo:
        return ToolInfo(
            name="git_status",
            category=ToolCategory.GIT,
            description="获取Git状态",
            parameters={
                "porcelain": {"type": "boolean", "required": False, "default": False, "description": "机器可读格式"}
            },
            required_permissions=["git.read"]
        )
    
    def validate_parameters(self, parameters: Dict[str, Any]) -> bool:
        return True
    
    def execute(self, parameters: Dict[str, Any]) -> Any:
        porcelain = parameters.get("porcelain", False)
        
        cmd = ["git", "status"]
        if porcelain:
            cmd.append("--porcelain")
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        return {
            "output": result.stdout,
            "error": result.stderr if result.returncode != 0 else None,
            "return_code": result.returncode
        }
```

### 2.4 上下文管理器实现

```python
# context_manager.py
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from datetime import datetime
import json
import hashlib


@dataclass
class FileInfo:
    """文件信息"""
    path: str
    content: str
    language: str
    size: int
    modified_time: datetime
    hash: str


@dataclass
class ProjectContext:
    """项目上下文"""
    root_path: str
    project_type: str
    dependencies: Dict[str, str]
    config_files: List[str]
    structure: Dict[str, Any]


@dataclass
class SessionContext:
    """会话上下文"""
    session_id: str
    start_time: datetime
    messages: List[Dict[str, Any]]
    open_files: List[str]
    current_task: Optional[str]


class ContextManager:
    """上下文管理器"""
    
    def __init__(self):
        self.project_context: Optional[ProjectContext] = None
        self.session_context: Optional[SessionContext] = None
        self.file_cache: Dict[str, FileInfo] = {}
        self.code_style_cache: Dict[str, Any] = {}
        self.dependency_graph: Dict[str, List[str]] = {}
    
    def initialize_project(self, root_path: str) -> ProjectContext:
        """初始化项目上下文"""
        # 检测项目类型
        project_type = self.detect_project_type(root_path)
        
        # 读取配置文件
        config_files = self.find_config_files(root_path)
        
        # 解析依赖
        dependencies = self.parse_dependencies(root_path, project_type)
        
        # 构建项目结构
        structure = self.build_project_structure(root_path)
        
        self.project_context = ProjectContext(
            root_path=root_path,
            project_type=project_type,
            dependencies=dependencies,
            config_files=config_files,
            structure=structure
        )
        
        return self.project_context
    
    def detect_project_type(self, root_path: str) -> str:
        """检测项目类型"""
        # 检查常见的项目标识文件
        indicators = {
            "package.json": "node",
            "requirements.txt": "python",
            "setup.py": "python",
            "pyproject.toml": "python",
            "Cargo.toml": "rust",
            "go.mod": "go",
            "pom.xml": "java",
            "build.gradle": "java",
            "CMakeLists.txt": "cpp",
            "Makefile": "c",
        }
        
        for indicator, project_type in indicators.items():
            if os.path.exists(os.path.join(root_path, indicator)):
                return project_type
        
        return "unknown"
    
    def parse_dependencies(self, root_path: str, project_type: str) -> Dict[str, str]:
        """解析依赖"""
        dependencies = {}
        
        if project_type == "node":
            # 解析 package.json
            package_json_path = os.path.join(root_path, "package.json")
            if os.path.exists(package_json_path):
                with open(package_json_path, 'r') as f:
                    package_data = json.load(f)
                    dependencies.update(package_data.get("dependencies", {}))
                    dependencies.update(package_data.get("devDependencies", {}))
        
        elif project_type == "python":
            # 解析 requirements.txt
            requirements_path = os.path.join(root_path, "requirements.txt")
            if os.path.exists(requirements_path):
                with open(requirements_path, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#'):
                            if '==' in line:
                                name, version = line.split('==')
                                dependencies[name.strip()] = version.strip()
                            else:
                                dependencies[line] = "latest"
        
        return dependencies
    
    def build_project_structure(self, root_path: str, max_depth: int = 3) -> Dict[str, Any]:
        """构建项目结构"""
        structure = {
            "type": "directory",
            "name": os.path.basename(root_path),
            "children": []
        }
        
        def scan_directory(path: str, depth: int) -> List[Dict[str, Any]]:
            if depth >= max_depth:
                return []
            
            items = []
            try:
                for item in os.listdir(path):
                    # 跳过隐藏文件和常见忽略目录
                    if item.startswith('.') or item in ['node_modules', '__pycache__', 'venv']:
                        continue
                    
                    item_path = os.path.join(path, item)
                    
                    if os.path.isdir(item_path):
                        items.append({
                            "type": "directory",
                            "name": item,
                            "children": scan_directory(item_path, depth + 1)
                        })
                    else:
                        # 获取文件信息
                        stat = os.stat(item_path)
                        items.append({
                            "type": "file",
                            "name": item,
                            "size": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                        })
            except PermissionError:
                pass
            
            return items
        
        structure["children"] = scan_directory(root_path, 0)
        return structure
    
    def get_file_info(self, file_path: str) -> FileInfo:
        """获取文件信息"""
        # 检查缓存
        if file_path in self.file_cache:
            cached = self.file_cache[file_path]
            # 检查文件是否被修改
            current_mtime = os.path.getmtime(file_path)
            if current_mtime == cached.modified_time.timestamp():
                return cached
        
        # 读取文件
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 检测语言
        language = self.detect_language(file_path)
        
        # 计算哈希
        file_hash = hashlib.md5(content.encode()).hexdigest()
        
        # 创建文件信息
        file_info = FileInfo(
            path=file_path,
            content=content,
            language=language,
            size=os.path.getsize(file_path),
            modified_time=datetime.fromtimestamp(os.path.getmtime(file_path)),
            hash=file_hash
        )
        
        # 更新缓存
        self.file_cache[file_path] = file_info
        
        return file_info
    
    def detect_language(self, file_path: str) -> str:
        """检测编程语言"""
        extension_map = {
            '.py': 'python',
            '.js': 'javascript',
            '.ts': 'typescript',
            '.jsx': 'javascript',
            '.tsx': 'typescript',
            '.java': 'java',
            '.c': 'c',
            '.cpp': 'cpp',
            '.h': 'c',
            '.hpp': 'cpp',
            '.go': 'go',
            '.rs': 'rust',
            '.rb': 'ruby',
            '.php': 'php',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.sh': 'bash',
            '.bash': 'bash',
            '.zsh': 'zsh',
            '.sql': 'sql',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.less': 'less',
            '.json': 'json',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.xml': 'xml',
            '.md': 'markdown',
            '.rst': 'rst',
            '.txt': 'text',
        }
        
        _, ext = os.path.splitext(file_path)
        return extension_map.get(ext.lower(), 'unknown')
    
    def get_code_style(self, language: str) -> Dict[str, Any]:
        """获取代码风格"""
        # 检查缓存
        if language in self.code_style_cache:
            return self.code_style_cache[language]
        
        # 分析项目中的代码风格
        style = self.analyze_code_style(language)
        
        # 缓存结果
        self.code_style_cache[language] = style
        
        return style
    
    def analyze_code_style(self, language: str) -> Dict[str, Any]:
        """分析代码风格"""
        # 这里可以实现更复杂的代码风格分析
        # 例如：缩进风格、命名约定、引号风格等
        
        style = {
            "language": language,
            "indent_style": "spaces",
            "indent_size": 4,
            "max_line_length": 100,
            "quote_style": "double",
            "trailing_comma": True,
            "semicolons": True if language in ['javascript', 'typescript'] else False,
        }
        
        # 根据语言调整默认值
        if language == 'python':
            style["indent_size"] = 4
            style["quote_style"] = "single"
            style["semicolons"] = False
        elif language in ['javascript', 'typescript']:
            style["indent_size"] = 2
            style["quote_style"] = "single"
            style["semicolons"] = True
        elif language == 'go':
            style["indent_style"] = "tabs"
            style["indent_size"] = 4
        
        return style
    
    def find_related_files(self, file_path: str) -> List[str]:
        """查找相关文件"""
        related = []
        
        # 获取文件信息
        file_info = self.get_file_info(file_path)
        
        # 基于文件名查找
        base_name = os.path.splitext(os.path.basename(file_path))[0]
        directory = os.path.dirname(file_path)
        
        # 查找测试文件
        test_patterns = [
            f"test_{base_name}.py",
            f"{base_name}_test.py",
            f"{base_name}.test.js",
            f"{base_name}.spec.js",
        ]
        
        for pattern in test_patterns:
            test_path = os.path.join(directory, pattern)
            if os.path.exists(test_path):
                related.append(test_path)
        
        # 查找相关模块
        if file_info.language == 'python':
            # 查找 __init__.py
            init_path = os.path.join(directory, '__init__.py')
            if os.path.exists(init_path):
                related.append(init_path)
        
        # 查找配置文件
        config_files = self.find_config_files(directory)
        related.extend(config_files)
        
        return related
    
    def find_config_files(self, directory: str) -> List[str]:
        """查找配置文件"""
        config_patterns = [
            'package.json', 'requirements.txt', 'setup.py', 'pyproject.toml',
            'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
            'Makefile', 'CMakeLists.txt', '.gitignore', '.editorconfig',
            'tsconfig.json', 'webpack.config.js', 'vite.config.js',
            'jest.config.js', 'pytest.ini', 'setup.cfg',
        ]
        
        config_files = []
        for pattern in config_patterns:
            config_path = os.path.join(directory, pattern)
            if os.path.exists(config_path):
                config_files.append(config_path)
        
        return config_files
```

### 2.5 任务调度器实现

```python
# task_scheduler.py
from typing import Dict, List, Any, Optional, Callable
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime
import uuid
import asyncio
from collections import deque


class TaskStatus(Enum):
    """任务状态"""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused"


class TaskPriority(Enum):
    """任务优先级"""
    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


@dataclass
class Task:
    """任务定义"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    description: str = ""
    status: TaskStatus = TaskStatus.PENDING
    priority: TaskPriority = TaskPriority.NORMAL
    
    # 任务内容
    action: Optional[Callable] = None
    parameters: Dict[str, Any] = field(default_factory=dict)
    
    # 依赖关系
    dependencies: List[str] = field(default_factory=list)
    dependents: List[str] = field(default_factory=list)
    
    # 执行信息
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    
    # 结果
    result: Any = None
    error: Optional[str] = None
    
    # 元数据
    metadata: Dict[str, Any] = field(default_factory=dict)


class TaskScheduler:
    """任务调度器"""
    
    def __init__(self, max_concurrent: int = 3):
        self.tasks: Dict[str, Task] = {}
        self.task_queue: deque = deque()
        self.running_tasks: Dict[str, asyncio.Task] = {}
        self.max_concurrent = max_concurrent
        self.lock = asyncio.Lock()
        
        # 回调函数
        self.on_task_start: Optional[Callable] = None
        self.on_task_complete: Optional[Callable] = None
        self.on_task_fail: Optional[Callable] = None
    
    def create_task(
        self,
        name: str,
        action: Callable,
        parameters: Dict[str, Any] = None,
        dependencies: List[str] = None,
        priority: TaskPriority = TaskPriority.NORMAL,
        description: str = "",
        metadata: Dict[str, Any] = None
    ) -> Task:
        """创建任务"""
        task = Task(
            name=name,
            description=description,
            action=action,
            parameters=parameters or {},
            dependencies=dependencies or [],
            priority=priority,
            metadata=metadata or {}
        )
        
        # 注册任务
        self.tasks[task.id] = task
        
        # 更新依赖关系
        for dep_id in task.dependencies:
            if dep_id in self.tasks:
                self.tasks[dep_id].dependents.append(task.id)
        
        # 添加到队列
        self.task_queue.append(task.id)
        
        # 按优先级排序
        self._sort_queue()
        
        return task
    
    def _sort_queue(self):
        """按优先级排序队列"""
        sorted_queue = sorted(
            self.task_queue,
            key=lambda task_id: self.tasks[task_id].priority.value,
            reverse=True
        )
        self.task_queue = deque(sorted_queue)
    
    async def start(self):
        """启动调度器"""
        while True:
            # 检查是否有可执行的任务
            await self._schedule_tasks()
            
            # 等待一段时间
            await asyncio.sleep(0.1)
    
    async def _schedule_tasks(self):
        """调度任务"""
        async with self.lock:
            # 检查是否有空闲槽位
            while len(self.running_tasks) < self.max_concurrent and self.task_queue:
                # 获取下一个可执行的任务
                task_id = self._get_next_task()
                
                if task_id is None:
                    break
                
                # 执行任务
                await self._execute_task(task_id)
    
    def _get_next_task(self) -> Optional[str]:
        """获取下一个可执行的任务"""
        for i, task_id in enumerate(self.task_queue):
            task = self.tasks[task_id]
            
            # 检查依赖是否完成
            if self._are_dependencies_met(task):
                # 从队列中移除
                self.task_queue.remove(task_id)
                return task_id
        
        return None
    
    def _are_dependencies_met(self, task: Task) -> bool:
        """检查依赖是否满足"""
        for dep_id in task.dependencies:
            if dep_id not in self.tasks:
                return False
            
            dep_task = self.tasks[dep_id]
            if dep_task.status != TaskStatus.COMPLETED:
                return False
        
        return True
    
    async def _execute_task(self, task_id: str):
        """执行任务"""
        task = self.tasks[task_id]
        
        # 更新状态
        task.status = TaskStatus.RUNNING
        task.started_at = datetime.now()
        
        # 触发回调
        if self.on_task_start:
            self.on_task_start(task)
        
        # 创建异步任务
        async_task = asyncio.create_task(self._run_task(task))
        self.running_tasks[task_id] = async_task
        
        # 等待任务完成
        try:
            result = await async_task
            
            # 更新状态
            task.status = TaskStatus.COMPLETED
            task.result = result
            task.completed_at = datetime.now()
            
            # 触发回调
            if self.on_task_complete:
                self.on_task_complete(task)
            
            # 检查依赖此任务的其他任务
            await self._check_dependents(task_id)
        
        except Exception as e:
            # 更新状态
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.completed_at = datetime.now()
            
            # 触发回调
            if self.on_task_fail:
                self.on_task_fail(task)
        
        finally:
            # 从运行列表中移除
            if task_id in self.running_tasks:
                del self.running_tasks[task_id]
    
    async def _run_task(self, task: Task) -> Any:
        """运行任务"""
        if task.action is None:
            raise ValueError("Task action is not defined")
        
        # 检查是否是协程函数
        if asyncio.iscoroutinefunction(task.action):
            return await task.action(**task.parameters)
        else:
            # 在线程池中运行同步函数
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, lambda: task.action(**task.parameters))
    
    async def _check_dependents(self, task_id: str):
        """检查依赖此任务的其他任务"""
        task = self.tasks[task_id]
        
        for dependent_id in task.dependents:
            dependent_task = self.tasks[dependent_id]
            
            # 检查是否所有依赖都完成
            if self._are_dependencies_met(dependent_task):
                # 添加到队列
                if dependent_id not in self.task_queue:
                    self.task_queue.append(dependent_id)
                    self._sort_queue()
    
    def get_task(self, task_id: str) -> Optional[Task]:
        """获取任务"""
        return self.tasks.get(task_id)
    
    def get_tasks_by_status(self, status: TaskStatus) -> List[Task]:
        """按状态获取任务"""
        return [task for task in self.tasks.values() if task.status == status]
    
    def cancel_task(self, task_id: str) -> bool:
        """取消任务"""
        task = self.tasks.get(task_id)
        if task is None:
            return False
        
        if task.status == TaskStatus.PENDING:
            # 从队列中移除
            if task_id in self.task_queue:
                self.task_queue.remove(task_id)
            task.status = TaskStatus.CANCELLED
            return True
        
        elif task.status == TaskStatus.RUNNING:
            # 取消异步任务
            if task_id in self.running_tasks:
                self.running_tasks[task_id].cancel()
                del self.running_tasks[task_id]
            task.status = TaskStatus.CANCELLED
            return True
        
        return False
    
    def pause_task(self, task_id: str) -> bool:
        """暂停任务"""
        task = self.tasks.get(task_id)
        if task is None:
            return False
        
        if task.status == TaskStatus.RUNNING:
            task.status = TaskStatus.PAUSED
            # 这里可以实现暂停逻辑
            return True
        
        return False
    
    def resume_task(self, task_id: str) -> bool:
        """恢复任务"""
        task = self.tasks.get(task_id)
        if task is None:
            return False
        
        if task.status == TaskStatus.PAUSED:
            task.status = TaskStatus.PENDING
            # 添加回队列
            self.task_queue.append(task_id)
            self._sort_queue()
            return True
        
        return False
    
    def get_progress(self) -> Dict[str, Any]:
        """获取进度"""
        total = len(self.tasks)
        completed = len([t for t in self.tasks.values() if t.status == TaskStatus.COMPLETED])
        failed = len([t for t in self.tasks.values() if t.status == TaskStatus.FAILED])
        running = len([t for t in self.tasks.values() if t.status == TaskStatus.RUNNING])
        pending = len([t for t in self.tasks.values() if t.status == TaskStatus.PENDING])
        
        return {
            "total": total,
            "completed": completed,
            "failed": failed,
            "running": running,
            "pending": pending,
            "progress": completed / total if total > 0 else 0
        }
```

## 三、配置和部署

### 3.1 配置文件

```yaml
# config.yaml
app:
  name: "MiMo Agentic Coding TUI"
  version: "1.0.0"
  debug: false

model:
  provider: "mimo"
  endpoint: "https://api.mimo.com/v1"
  api_key: "${MIMO_API_KEY}"
  model: "mimo-v2.5-pro"
  max_tokens: 4096
  temperature: 0.7

tui:
  theme: "dark"
  font_size: 14
  show_line_numbers: true
  word_wrap: true
  auto_save: true
  auto_save_interval: 300

tools:
  enabled:
    - file_read
    - file_write
    - file_edit
    - git_status
    - git_commit
    - git_push
    - terminal_execute
    - code_format
    - code_lint
    - test_run
  
  permissions:
    file_read: true
    file_write: true
    terminal_execute: false  # 需要用户确认
    git_push: false  # 需要用户确认

context:
  max_history: 100
  cache_size: 1000
  auto_detect_project: true
  ignore_patterns:
    - "node_modules"
    - ".git"
    - "__pycache__"
    - "venv"
    - ".env"

logging:
  level: "INFO"
  file: "logs/mimo-tui.log"
  max_size: "10MB"
  backup_count: 5

server:
  host: "0.0.0.0"
  port: 8000
  workers: 4
  cors_origins:
    - "http://localhost:3000"
    - "http://localhost:8080"
```

### 3.2 启动脚本

```python
#!/usr/bin/env python3
# main.py
import asyncio
import argparse
import sys
from pathlib import Path

from mimo_tui.app import MiMoTUI
from mimo_tui.config import load_config
from mimo_tui.server import start_server


def main():
    parser = argparse.ArgumentParser(description="MiMo Agentic Coding TUI")
    parser.add_argument("--config", "-c", help="配置文件路径", default="config.yaml")
    parser.add_argument("--mode", "-m", choices=["tui", "server", "both"], default="tui")
    parser.add_argument("--port", "-p", type=int, help="服务器端口")
    parser.add_argument("--debug", "-d", action="store_true", help="调试模式")
    
    args = parser.parse_args()
    
    # 加载配置
    config = load_config(args.config)
    
    if args.debug:
        config.app.debug = True
    
    if args.port:
        config.server.port = args.port
    
    # 启动应用
    if args.mode == "tui":
        app = MiMoTUI(config)
        app.run()
    elif args.mode == "server":
        asyncio.run(start_server(config))
    elif args.mode == "both":
        # 同时启动TUI和服务器
        app = MiMoTUI(config)
        asyncio.gather(
            app.run_async(),
            start_server(config)
        )


if __name__ == "__main__":
    main()
```

## 四、测试方案

### 4.1 单元测试示例

```python
# tests/test_reasoning_engine.py
import pytest
from unittest.mock import Mock, AsyncMock
from mimo_tui.reasoning_engine import ReasoningEngine, IntentType


class TestReasoningEngine:
    """推理引擎测试"""
    
    @pytest.fixture
    def engine(self):
        """创建推理引擎实例"""
        mimo_client = Mock()
        mimo_client.generate = AsyncMock(return_value='{"type": "code_generation", "confidence": 0.95}')
        return ReasoningEngine(mimo_client)
    
    @pytest.mark.asyncio
    async def test_understand_intent_code_generation(self, engine):
        """测试代码生成意图识别"""
        user_input = "写一个Python函数，计算斐波那契数列"
        context = {"current_file": "main.py", "project_type": "python"}
        
        intent = await engine.understand_intent(user_input, context)
        
        assert intent.type == IntentType.CODE_GENERATION
        assert intent.confidence > 0.8
    
    @pytest.mark.asyncio
    async def test_understand_intent_debugging(self, engine):
        """测试调试意图识别"""
        mimo_client.generate.return_value = '{"type": "debugging", "confidence": 0.9}'
        engine.mimo = mimo_client
        
        user_input = "这段代码报错了，帮我看看"
        context = {"error_info": "TypeError: ..."}
        
        intent = await engine.understand_intent(user_input, context)
        
        assert intent.type == IntentType.DEBUGGING
    
    @pytest.mark.asyncio
    async def test_create_plan(self, engine):
        """测试创建执行计划"""
        from mimo_tui.reasoning_engine import UserIntent
        
        intent = UserIntent(
            type=IntentType.CODE_GENERATION,
            confidence=0.95,
            parameters={"description": "斐波那契函数"},
            raw_input="写一个斐波那契函数"
        )
        
        context = {"language": "python", "code_style": {"indent_size": 4}}
        
        plan = await engine.create_plan(intent, context)
        
        assert len(plan.steps) > 0
        assert plan.estimated_time > 0
```

### 4.2 集成测试示例

```python
# tests/test_integration.py
import pytest
import asyncio
from mimo_tui.app import MiMoTUI
from mimo_tui.config import TestConfig


class TestIntegration:
    """集成测试"""
    
    @pytest.fixture
    def app(self):
        """创建应用实例"""
        config = TestConfig()
        return MiMoTUI(config)
    
    @pytest.mark.asyncio
    async def test_full_workflow(self, app):
        """测试完整工作流程"""
        # 1. 初始化项目
        await app.initialize_project("/path/to/project")
        
        # 2. 发送消息
        response = await app.process_message("创建一个Hello World程序")
        
        # 3. 验证响应
        assert response is not None
        assert "Hello World" in response
        
        # 4. 检查文件是否创建
        assert os.path.exists("/path/to/project/hello.py")
```

## 五、性能优化建议

### 5.1 响应速度优化
1. **流式输出**：实现流式输出，减少用户等待时间
2. **预测执行**：预判用户意图，提前准备资源
3. **缓存机制**：缓存常用操作结果
4. **并行处理**：并行执行独立任务

### 5.2 内存使用优化
1. **懒加载**：按需加载资源
2. **缓存策略**：实现LRU缓存
3. **资源释放**：及时释放不用的资源
4. **内存监控**：监控内存使用情况

### 5.3 网络优化
1. **请求合并**：合并多个小请求
2. **压缩传输**：压缩传输数据
3. **连接池**：使用连接池
4. **断点续传**：支持断点续传

## 六、总结

本技术实现方案提供了MiMo Agentic Coding TUI的完整实现细节，包括：

1. **分层架构**：清晰的分层架构设计
2. **核心组件**：详细的组件实现代码
3. **配置管理**：灵活的配置管理方案
4. **测试方案**：完整的测试策略
5. **性能优化**：实用的性能优化建议

这个方案可以作为实际开发的参考，帮助构建一个高效、稳定、易用的Agentic Coding TUI系统。