import os
from pathlib import Path
from jupyterlab.labapp import LabApp
from traitlets.config import Config

token = Path(os.environ["JUPYTER_TOKEN_FILE"]).read_text().strip()
config = Config()
config.IdentityProvider.token = token
config.ServerApp.root_dir = "/notebooks"
config.ServerApp.ip = "0.0.0.0"
config.ServerApp.port = 8888
config.ServerApp.open_browser = False
config.ServerApp.log_level = "WARNING"
LabApp.launch_instance(config=config)
