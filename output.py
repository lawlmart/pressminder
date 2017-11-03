import json
import time
output = [{'timestamp': (1509687703 - 3600 * x)} for x in range(1,720)]
print json.dumps(output)
